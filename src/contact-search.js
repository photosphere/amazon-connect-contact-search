import {
  ConnectClient,
  DescribeContactCommand,
  GetContactAttributesCommand,
  ListContactReferencesCommand,
} from "@aws-sdk/client-connect";

import {
  ConnectContactLensClient,
  ListRealtimeContactAnalysisSegmentsCommand,
} from "@aws-sdk/client-connect-contact-lens";

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// ── Helpers ──────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function formatTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return isNaN(d) ? String(ts) : d.toLocaleString("zh-CN");
}

function durationStr(seconds) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

function channelBadge(ch) {
  const c = (ch || "").toUpperCase();
  if (c === "VOICE") return '<span class="badge voice">📞 VOICE</span>';
  if (c === "CHAT") return '<span class="badge chat">💬 CHAT</span>';
  if (c === "TASK") return '<span class="badge task">📋 TASK</span>';
  if (c === "EMAIL") return '<span class="badge email">📧 EMAIL</span>';
  return `<span class="badge">${ch || "—"}</span>`;
}

function makeDetailItem(label, value, cls = "") {
  return `<div class="detail-item"><div class="label">${label}</div><div class="value ${cls}">${value || "—"}</div></div>`;
}

function setStatus(type, text) {
  $("status-dot").className = "status-dot " + type;
  $("status-text").textContent = text;
}

function showError(msg) {
  $("error-container").innerHTML = `<div class="error-state">❌ ${msg}</div>`;
}

function clearError() {
  $("error-container").innerHTML = "";
}

// ── SDK clients ──────────────────────────────────────────────
function makeConnectClient(cfg) {
  return new ConnectClient({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      ...(cfg.sessionToken && { sessionToken: cfg.sessionToken }),
    },
  });
}

function makeContactLensClient(cfg) {
  return new ConnectContactLensClient({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      ...(cfg.sessionToken && { sessionToken: cfg.sessionToken }),
    },
  });
}

function makeS3Client(cfg) {
  return new S3Client({
    region: cfg.region,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      ...(cfg.sessionToken && { sessionToken: cfg.sessionToken }),
    },
  });
}

// ── API calls ────────────────────────────────────────────────
async function describeContact(client, instanceId, contactId) {
  const res = await client.send(
    new DescribeContactCommand({ InstanceId: instanceId, ContactId: contactId })
  );
  return res.Contact;
}

async function getContactAttributes(client, instanceId, contactId) {
  const res = await client.send(
    new GetContactAttributesCommand({ InstanceId: instanceId, ContactId: contactId })
  );
  return res.Attributes || {};
}

function findChatRecording(contact) {
  return (contact.Recordings || []).find(
    (r) => r.MediaStreamType === "CHAT" && r.Status === "AVAILABLE" && r.Location
  );
}

async function getChatTranscriptFromS3(s3Client, location) {
  const idx = location.indexOf("/");
  if (idx < 0) throw new Error(`无法解析 S3 路径: ${location}`);
  const bucket = location.slice(0, idx);
  const key = location.slice(idx + 1);
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  const res = await fetch(presignedUrl);
  if (!res.ok) throw new Error(`S3 下载失败: ${res.status} ${res.statusText}`);
  return res.json();
}

async function getVoiceTranscript(lensClient, instanceId, contactId) {
  const segments = [];
  let nextToken;
  do {
    const res = await lensClient.send(
      new ListRealtimeContactAnalysisSegmentsCommand({
        InstanceId: instanceId,
        ContactId: contactId,
        MaxResults: 100,
        ...(nextToken && { NextToken: nextToken }),
      })
    );
    segments.push(...(res.Segments ?? []));
    nextToken = res.NextToken;
  } while (nextToken);
  return segments;
}

// ── Attachments via ListContactReferences + S3 presigned URL ─

// Parse an S3 URL or path into { bucket, key }
// Handles both:
//   "bucket/key/path" (plain S3 location)
//   "https://bucket.s3.region.amazonaws.com/key" (S3 URL)
function parseS3Path(value) {
  if (!value) return null;
  try {
    if (value.startsWith("http")) {
      const u = new URL(value.split("?")[0]); // strip query params
      // Virtual-hosted style: bucket.s3.region.amazonaws.com
      const hostParts = u.hostname.split(".");
      const s3Idx = hostParts.indexOf("s3");
      if (s3Idx > 0) {
        const bucket = hostParts.slice(0, s3Idx).join(".");
        const key = decodeURIComponent(u.pathname.slice(1)); // remove leading /
        return { bucket, key };
      }
    }
  } catch { /* not a URL */ }
  // Plain "bucket/key" format
  const idx = value.indexOf("/");
  if (idx > 0) return { bucket: value.slice(0, idx), key: value.slice(idx + 1) };
  return null;
}

// Call ListContactReferences for ATTACHMENT type, then generate S3 presigned URLs
async function getAttachmentPresignedUrls(connectClient, s3Client, instanceId, contactId) {
  // 1. List all ATTACHMENT references
  const refs = [];
  let nextToken;
  do {
    const res = await connectClient.send(
      new ListContactReferencesCommand({
        InstanceId: instanceId,
        ContactId: contactId,
        ReferenceTypes: ["ATTACHMENT"],
        ...(nextToken && { NextToken: nextToken }),
      })
    );
    refs.push(...(res.ReferenceSummaryList ?? []));
    nextToken = res.NextToken;
  } while (nextToken);

  console.log("[Attachments] ListContactReferences returned:", refs.length, "refs");
  console.log("[Attachments] Raw refs:", JSON.stringify(refs, null, 2));

  // 2. For each attachment ref, parse S3 path and generate presigned URL
  const byId = {};   // attachmentId → presigned URL
  const byName = {}; // refName → presigned URL

  for (const ref of refs) {
    const att = ref.Attachment;
    if (!att) continue;

    const refName = att.Name || "";
    const s3Value = att.Value || "";

    // Parse S3 location from the Value field
    const s3Loc = parseS3Path(s3Value);
    if (!s3Loc) {
      console.warn("[Attachments] Cannot parse S3 path from:", s3Value);
      continue;
    }

    try {
      const command = new GetObjectCommand({ Bucket: s3Loc.bucket, Key: s3Loc.key });
      const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

      if (refName) byName[refName] = presignedUrl;

      // Extract UUIDs from the S3 key to match against AttachmentId
      const uuids = s3Loc.key.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
      ) || [];
      for (const uuid of uuids) {
        byId[uuid] = presignedUrl;
      }

      console.log("[Attachments] Presigned URL for", refName, "→", presignedUrl.slice(0, 100) + "...");
    } catch (e) {
      console.warn("[Attachments] Failed to presign for", refName, ":", e.message);
    }
  }

  console.log("[Attachments] byName keys:", Object.keys(byName));
  console.log("[Attachments] byId keys:", Object.keys(byId));
  return { byName, byId, rawRefs: refs };
}

// ── Render ───────────────────────────────────────────────────
function renderContact(contact) {
  $("basic-grid").innerHTML = [
    makeDetailItem("Contact ID", contact.Id),
    makeDetailItem("渠道", channelBadge(contact.Channel)),
    makeDetailItem("发起方式", contact.InitiationMethod),
    makeDetailItem("发起时间", formatTime(contact.InitiationTimestamp)),
    makeDetailItem("断开时间", formatTime(contact.DisconnectTimestamp)),
    makeDetailItem("断开原因", contact.DisconnectReason),
    makeDetailItem("通话时长",
      contact.InitiationTimestamp && contact.DisconnectTimestamp
        ? durationStr((new Date(contact.DisconnectTimestamp) - new Date(contact.InitiationTimestamp)) / 1000)
        : "—"),
    makeDetailItem("上一个 Contact ID", contact.PreviousContactId),
    makeDetailItem("初始 Contact ID", contact.InitialContactId),
    makeDetailItem("关联 Contact ID", contact.RelatedContactId),
    makeDetailItem("描述", contact.Description),
    makeDetailItem("名称", contact.Name),
  ].join("");

  if (contact.AgentInfo) {
    $("panel-agent").style.display = "";
    $("agent-grid").innerHTML = [
      makeDetailItem("坐席 ARN", contact.AgentInfo.Id),
      makeDetailItem("连接时间", formatTime(contact.AgentInfo.ConnectedToAgentTimestamp)),
      makeDetailItem("坐席暂停时长",
        contact.AgentInfo.AgentPauseDurationInSeconds != null
          ? durationStr(contact.AgentInfo.AgentPauseDurationInSeconds) : "—"),
    ].join("");
  } else {
    $("panel-agent").style.display = "none";
  }

  if (contact.QueueInfo) {
    $("panel-queue").style.display = "";
    $("queue-grid").innerHTML = [
      makeDetailItem("队列 ARN", contact.QueueInfo.Id),
      makeDetailItem("入队时间", formatTime(contact.QueueInfo.EnqueueTimestamp)),
    ].join("");
  } else {
    $("panel-queue").style.display = "none";
  }
}

function renderAttributes(attrs) {
  const keys = Object.keys(attrs);
  if (!keys.length) { $("panel-attributes").style.display = "none"; return; }
  $("panel-attributes").style.display = "";
  $("attributes-grid").innerHTML = keys.sort()
    .map((k) => makeDetailItem(k, escapeHtml(attrs[k]))).join("");
}

function renderChatTranscript(transcriptData, attachmentMaps) {
  const container = $("transcript-container");
  const { byName = {}, byId = {} } = attachmentMaps || {};

  const participants = transcriptData.Participants || [];
  const transcript = transcriptData.Transcript || [];

  if (!transcript.length) {
    container.innerHTML = '<div class="empty-state" style="padding:30px;">暂无聊天记录</div>';
    return;
  }

  const pMap = {};
  for (const p of participants) {
    pMap[p.ParticipantId] = { role: p.ParticipantRole, displayName: p.DisplayName };
  }

  container.innerHTML = transcript.map((item) => {
    const pInfo = pMap[item.ParticipantId] || {};
    const role = (item.ParticipantRole || pInfo.role || "").toUpperCase();
    const isEvent = item.Type === "EVENT";
    const isAttachment = item.Type === "ATTACHMENT";

    let cls = "system";
    if (!isEvent) {
      if (role === "CUSTOMER") cls = "customer";
      else if (role === "AGENT") cls = "agent";
    }

    const time = item.AbsoluteTime
      ? new Date(item.AbsoluteTime).toLocaleTimeString("zh-CN") : "";
    const name = item.DisplayName || pInfo.displayName || role || "—";
    const contentType = item.ContentType || "";
    let content = item.Content || "";

    if (isEvent) {
      if (contentType.includes("participant.joined")) content = `${name} 加入了对话`;
      else if (contentType.includes("participant.left")) content = `${name} 离开了对话`;
      else if (contentType.includes("chat.ended")) content = "对话已结束";
      else if (contentType.includes("transfer.succeeded")) content = "转接成功";
      else if (contentType.includes("transfer.failed")) content = "转接失败";
      else content = content || contentType;
      cls = "system";
    }

    let bubbleHtml = "";

    if (isAttachment && item.Attachments && item.Attachments.length > 0) {
      bubbleHtml = item.Attachments.map((att) => {
        const attContentType = (att.ContentType || "").toLowerCase();
        const attName = att.AttachmentName || att.AttachmentId;
        // Match by: AttachmentName in byName, or AttachmentId in byId
        const attUrl = byName[attName] || byId[att.AttachmentId] || null;
        const isImage = attContentType.startsWith("image/");

        if (isImage && attUrl) {
          return `<div class="attachment-item">
            <a href="${escapeAttr(attUrl)}" target="_blank" rel="noopener">
              <img src="${escapeAttr(attUrl)}" alt="${escapeHtml(attName)}" class="attachment-image"
                onerror="this.style.display='none';this.nextElementSibling.style.display=''" />
              <span class="attachment-error" style="display:none;color:#f59e0b;font-size:0.82rem;">⚠ 图片加载失败，点击新窗口打开</span>
            </a>
            <div class="attachment-name">${escapeHtml(attName)}</div>
          </div>`;
        } else if (attUrl) {
          return `<div class="attachment-item">
            <a href="${escapeAttr(attUrl)}" target="_blank" rel="noopener" class="attachment-link">📎 ${escapeHtml(attName)}</a>
          </div>`;
        } else {
          return `<div class="attachment-item">
            <span class="attachment-unavailable">📎 ${escapeHtml(attName)}（${att.Status || "无法加载"}）</span>
          </div>`;
        }
      }).join("");
    } else {
      bubbleHtml = escapeHtml(content);
    }

    return `<div class="chat-message ${cls}">
      <div class="chat-bubble">${bubbleHtml}</div>
      <div class="chat-meta">${escapeHtml(name)} · ${time}</div>
    </div>`;
  }).join("");
}

function renderVoiceTranscript(segments) {
  const container = $("transcript-container");
  const transcriptItems = segments.filter((s) => s.Transcript);
  if (!transcriptItems.length) {
    container.innerHTML = '<div class="empty-state" style="padding:30px;">暂无语音转录记录</div>';
    return;
  }
  container.innerHTML = transcriptItems.map((seg) => {
    const t = seg.Transcript;
    const role = (t.ParticipantRole || "").toUpperCase();
    let cls = "system";
    if (role === "CUSTOMER") cls = "customer";
    else if (role === "AGENT") cls = "agent";
    const begin = t.BeginOffsetMillis != null ? (t.BeginOffsetMillis / 1000).toFixed(1) + "s" : "";
    const end = t.EndOffsetMillis != null ? (t.EndOffsetMillis / 1000).toFixed(1) + "s" : "";
    const timeRange = begin && end ? `${begin} – ${end}` : "";
    const sentiment = t.Sentiment ? ` | 情绪: ${t.Sentiment}` : "";
    return `<div class="voice-segment">
      <div class="speaker ${cls}">${t.ParticipantRole || "—"}</div>
      <div class="text">${escapeHtml(t.Content || "")}</div>
      <div class="timestamp">${timeRange}${sentiment}</div>
    </div>`;
  }).join("");
}

// ── Main search ──────────────────────────────────────────────
function getConfig() {
  return {
    accessKeyId: $("cfg-access-key").value.trim(),
    secretAccessKey: $("cfg-secret-key").value.trim(),
    sessionToken: $("cfg-session-token").value.trim() || undefined,
    region: $("cfg-region").value.trim() || "us-east-1",
    instanceId: $("cfg-instance-id").value.trim(),
    contactId: $("cfg-contact-id").value.trim(),
  };
}

async function doSearch() {
  const cfg = getConfig();
  clearError();
  if (!cfg.accessKeyId || !cfg.secretAccessKey) { showError("请填写 AWS Access Key ID 和 Secret Access Key"); return; }
  if (!cfg.instanceId) { showError("请填写 Connect 实例 ID"); return; }
  if (!cfg.contactId) { showError("请填写 Contact ID"); return; }

  $("empty-state").style.display = "none";
  $("results-container").style.display = "none";
  $("loading-container").style.display = "";
  setStatus("loading", "查询中...");

  const client = makeConnectClient(cfg);
  const lensClient = makeContactLensClient(cfg);
  const s3Client = makeS3Client(cfg);
  const allData = {};

  try {
    // 1. DescribeContact
    const contact = await describeContact(client, cfg.instanceId, cfg.contactId);
    allData.contact = contact;
    console.log("[DescribeContact] Full response:", JSON.stringify(contact, null, 2));
    renderContact(contact);

    // 2. GetContactAttributes
    try {
      const attrs = await getContactAttributes(client, cfg.instanceId, cfg.contactId);
      allData.attributes = attrs;
      renderAttributes(attrs);
    } catch (e) {
      console.warn("GetContactAttributes failed:", e);
      $("panel-attributes").style.display = "none";
    }

    // 3. Transcript based on channel
    const channel = (contact.Channel || "").toUpperCase();

    if (channel === "CHAT") {
      const chatRecording = findChatRecording(contact);
      if (chatRecording) {
        try {
          const transcriptData = await getChatTranscriptFromS3(s3Client, chatRecording.Location);
          allData.chatTranscript = transcriptData;

          // Get attachment presigned URLs via ListContactReferences + S3
          let attachmentMaps = { byName: {}, byId: {} };
          try {
            const result = await getAttachmentPresignedUrls(client, s3Client, cfg.instanceId, cfg.contactId);
            attachmentMaps = result;
            allData.attachmentReferences = result.rawRefs;
          } catch (e) {
            console.warn("getAttachmentPresignedUrls failed:", e);
          }

          renderChatTranscript(transcriptData, attachmentMaps);
        } catch (e) {
          $("transcript-container").innerHTML = `<div class="empty-state" style="padding:30px;">加载聊天记录失败: ${escapeHtml(e.message)}<br/><small>S3 路径: ${escapeHtml(chatRecording.Location)}</small></div>`;
        }
      } else {
        $("transcript-container").innerHTML = '<div class="empty-state" style="padding:30px;">未找到可用的聊天记录（Recordings 中无 CHAT 类型或状态非 AVAILABLE）</div>';
      }
    } else if (channel === "VOICE") {
      try {
        const segments = await getVoiceTranscript(lensClient, cfg.instanceId, cfg.contactId);
        allData.voiceSegments = segments;
        renderVoiceTranscript(segments);
      } catch (e) {
        $("transcript-container").innerHTML = `<div class="empty-state" style="padding:30px;">加载语音转录失败: ${escapeHtml(e.message)}<br/><small>请确认已启用 Contact Lens 实时分析</small></div>`;
      }
    } else {
      $("transcript-container").innerHTML = `<div class="empty-state" style="padding:30px;">该渠道 (${escapeHtml(channel || "未知")}) 暂不支持记录展示</div>`;
    }

    $("raw-json").textContent = JSON.stringify(allData, null, 2);
    $("results-container").style.display = "";
    setStatus("ok", "查询完成");
  } catch (err) {
    showError(err.message || "API 调用失败，请检查配置和网络");
    setStatus("error", "查询失败");
  } finally {
    $("loading-container").style.display = "none";
  }
}

// ── Event bindings ───────────────────────────────────────────
$("btn-search").addEventListener("click", doSearch);
$("cfg-contact-id").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
$("btn-clear").addEventListener("click", () => {
  $("results-container").style.display = "none";
  $("empty-state").style.display = "";
  $("error-container").innerHTML = "";
  $("cfg-contact-id").value = "";
  setStatus("", "就绪");
});
$("cred-toggle").addEventListener("click", () => {
  $("cred-toggle").classList.toggle("open");
  $("cred-body").classList.toggle("open");
});
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");
  });
});

// ── Load config.json ─────────────────────────────────────────
(async function loadConfig() {
  try {
    const res = await fetch("config.json");
    if (!res.ok) return;
    const cfg = await res.json();
    if (cfg.accessKeyId) $("cfg-access-key").value = cfg.accessKeyId;
    if (cfg.secretAccessKey) $("cfg-secret-key").value = cfg.secretAccessKey;
    if (cfg.sessionToken) $("cfg-session-token").value = cfg.sessionToken;
    if (cfg.region) $("cfg-region").value = cfg.region;
    if (cfg.instanceId) $("cfg-instance-id").value = cfg.instanceId;
    console.info("已从 config.json 加载默认配置");
  } catch { /* no config.json */ }
})();
