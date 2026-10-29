const el = (id) => document.getElementById(id);
let key = "", selected = "", timer, busy = false, generation = 0;
const status = (text) => { el("status").textContent = text; };
function controls() {
  el("create").disabled = el("refresh").disabled = !key || busy;
  for (const button of document.querySelectorAll("[data-action]")) button.disabled = !key || !selected || busy;
  el("copy").disabled = !el("view").value;
}
async function api(route, method = "GET", body) {
  const started = generation;
  const response = await fetch(route, {
    method, headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: "no-store", credentials: "omit", signal: AbortSignal.timeout(90000)
  });
  const result = await response.json();
  if (started !== generation) throw new Error("Disconnected.");
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}
function select(id) {
  selected = id; el("selected").textContent = id || "None"; el("view").value = ""; el("expiry").textContent = "";
  clearInterval(timer);
  if (id) timer = setInterval(() => api(`/api/sessions/${selected}/heartbeat`, "POST").catch((error) => status(error.message)), 30000);
  controls();
}
function view(result) {
  el("view").value = result.viewUrl;
  el("expiry").textContent = `Viewing access expires ${new Date(result.viewExpiresAt).toLocaleString()}. Session ends by ${new Date(result.expiresAt).toLocaleString()}.`;
  controls();
}
async function refresh() {
  const sessions = await api("/api/sessions");
  el("sessions").replaceChildren();
  for (const session of sessions) {
    const row = document.createElement("li"), button = document.createElement("button");
    button.textContent = `${session.profile}: ${session.id}`;
    button.onclick = () => { select(session.id); status("Selected. Request a new viewing link to share."); };
    row.append(button); el("sessions").append(row);
  }
}
async function run(task) {
  if (busy) return;
  busy = true; controls();
  try { await task(); } catch (error) { status(error.message); }
  finally { busy = false; controls(); }
}
el("connect").onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    generation++; key = el("key").value.trim(); el("key").value = ""; select("");
    try { await refresh(); status("Connected."); }
    catch (error) { key = ""; throw error; }
  });
};
el("disconnect").onclick = () => { generation++; key = ""; el("key").value = ""; select(""); el("sessions").replaceChildren(); status("Disconnected. Existing sessions expire without heartbeats."); };
el("refresh").onclick = () => run(refresh);
el("create").onclick = () => run(async () => {
  status("Starting browser and encoder...");
  const result = await api("/api/sessions", "POST", { profile: el("profile").value });
  select(result.id); view(result); await refresh(); status("Session ready. Check what is visible before sharing.");
});
for (const button of document.querySelectorAll("[data-action]")) button.onclick = () => run(async () => {
  const action = button.dataset.action;
  const result = await api(`/api/sessions/${selected}/${action}`, "POST");
  if (action === "share") view(result);
  if (action === "close") { select(""); await refresh(); }
  status(`${action}: complete`);
});
el("copy").onclick = () => navigator.clipboard.writeText(el("view").value).then(() => status("Viewing link copied. Keep it private."), () => status("Clipboard unavailable. Select the viewing link field to copy it manually."));
window.addEventListener("pagehide", () => { generation++; key = ""; select(""); el("key").value = ""; });
