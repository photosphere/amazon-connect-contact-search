import {
  ConnectClient,
  ListContactReferencesCommand,
} from "@aws-sdk/client-connect";

const $ = (id) => document.getElementById(id);

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

let cachedCfg = {};

async function loadConfig() {
  try {
    const res = await fetch("config.json");
    if (!res.ok) return;
    cachedCfg = await res.json();
    if (cachedCfg.instanceId) $("cfg-instance-id").value = cachedCfg.instanceId;
    console.info("已从 config.json 加载配置");
  } catch { /* no config.json */ }
}

function getSelectedTypes() {
  return [...document.querySelectorAll('.ref-types input[type="checkbox"]:checked')]
    .map((cb) => cb.value);
}

async function doSearch() {
  clearError();
  const instanceId = $("cfg-instance-id").value.trim();
  const contactId = $("cfg-contact-id").value.trim();
  const refTypes = getSelectedTypes();

  if (!cachedCfg.accessKeyId || !cachedCfg.secretAccessKey) {
    showError("config.json 中缺少 accessKeyId 或 secretAccessKey");
    return;
  }
  if (!instanceId) { showError("请填写 Connect 实例 ID"); return; }
  if (!contactId) { showError("请填写 Contact ID"); return; }
  if (!refTypes.length) { showError("请至少选择一种 Reference Type"); return; }

  $("empty-state").style.display = "none";
  $("json-output").style.display = "none";
  $("loading-container").style.display = "";
  setStatus("loading", "查询中...");

  const client = new ConnectClient({
    region: cachedCfg.region || "us-east-1",
    credentials: {
      accessKeyId: cachedCfg.accessKeyId,
      secretAccessKey: cachedCfg.secretAccessKey,
      ...(cachedCfg.sessionToken && { sessionToken: cachedCfg.sessionToken }),
    },
  });

  try {
    const allRefs = [];
    let nextToken;
    do {
      const res = await client.send(
        new ListContactReferencesCommand({
          InstanceId: instanceId,
          ContactId: contactId,
          ReferenceTypes: refTypes,
          ...(nextToken && { NextToken: nextToken }),
        })
      );
      allRefs.push(...(res.ReferenceSummaryList ?? []));
      nextToken = res.NextToken;
    } while (nextToken);

    $("json-output").textContent = JSON.stringify(allRefs, null, 2);
    $("json-output").style.display = "";
    setStatus("ok", `查询完成，共 ${allRefs.length} 条`);
  } catch (err) {
    showError(err.message || "API 调用失败");
    setStatus("error", "查询失败");
  } finally {
    $("loading-container").style.display = "none";
  }
}

$("btn-search").addEventListener("click", doSearch);
$("cfg-contact-id").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });
$("btn-clear").addEventListener("click", () => {
  $("json-output").style.display = "none";
  $("empty-state").style.display = "";
  $("error-container").innerHTML = "";
  $("cfg-contact-id").value = "";
  setStatus("", "就绪");
});

loadConfig();
