/* QR Shield – static client-side QR scanner and local URL analyzer */
"use strict";

/* ---------- Helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const RISK_LABEL = { LOW: "LOW RISK", MEDIUM: "MEDIUM RISK", HIGH: "HIGH RISK", UNVERIFIED: "UNVERIFIED" };

function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast.id); toast.id = setTimeout(() => t.classList.remove("show"), 2200);
}
function setStatus(msg, kind) {
  const s = $("#status");
  if (!msg) { s.hidden = true; return; }
  s.hidden = false; s.textContent = msg; s.className = "status" + (kind ? " " + kind : "");
}

/* ---------- Storage (history) ---------- */
const KEY = "qrshield.history.v1";
let history = [];
try { history = JSON.parse(localStorage.getItem(KEY)) || []; } catch (e) { history = []; }
function saveHistory() { try { localStorage.setItem(KEY, JSON.stringify(history.slice(0, 100))); } catch (e) { /* storage unavailable */ } }

/* ---------- Navigation ---------- */
function showView(name) {
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + name));
  $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name !== "scan") stopCamera();
  if (name === "dashboard" || name === "history") renderLists();
  window.scrollTo(0, 0);
}
$$(".nav-btn").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));
$$("[data-go]").forEach((b) => b.addEventListener("click", () => showView(b.dataset.go)));
$$(".tab").forEach((t) => t.addEventListener("click", () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $("#tab-upload").hidden = t.dataset.tab !== "upload";
  $("#tab-camera").hidden = t.dataset.tab !== "camera";
  if (t.dataset.tab !== "camera") stopCamera();
  setStatus("");
}));

/* ---------- Module 1: Decoding ---------- */
function decodeCanvasAll(canvas, max = 5) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const found = [];
  for (let i = 0; i < max; i++) {
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
    if (!code || !code.data) break;
    found.push(code.data);
    // Blank out the decoded code so another one can be found
    const l = code.location, pts = [l.topLeftCorner, l.topRightCorner, l.bottomRightCorner, l.bottomLeftCorner];
    ctx.fillStyle = "#808080"; ctx.strokeStyle = "#808080"; ctx.lineWidth = 12;
    ctx.beginPath(); pts.forEach((p, j) => (j ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.fill(); ctx.stroke();
  }
  return found;
}

function makeThumb(source, w, h) {
  const c = document.createElement("canvas"), s = Math.min(1, 160 / Math.max(w, h));
  c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.7);
}

function handleFile(file) {
  if (!file) return;
  if (!/^image\/(png|jpe?g)$/i.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) {
    return setStatus("Unsupported file. Choose a PNG, JPG or JPEG image.", "error");
  }
  setStatus("Reading image and looking for QR codes…", "loading");
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => {
    $("#preview").src = url; $("#preview-wrap").hidden = false;
    const k = Math.min(1, 1600 / Math.max(img.width, img.height));
    const c = document.createElement("canvas"); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    const thumb = makeThumb(img, img.width, img.height);
    const codes = decodeCanvasAll(c);
    if (!codes.length) return setStatus("No QR code found. Use a sharper, well-lit image where the whole code is visible.", "error");
    setStatus("");
    finishScan(codes, thumb, url);
  };
  img.onerror = () => setStatus("This file could not be read as an image. It may be corrupt.", "error");
  img.src = url;
}
const fileInput = $("#file"), drop = $("#drop");
fileInput.addEventListener("change", () => { handleFile(fileInput.files[0]); fileInput.value = ""; });
drop.addEventListener("click", (e) => { if (e.target !== fileInput) fileInput.click(); });
drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
["dragover", "dragenter"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));

/* Camera */
let stream = null, raf = 0;
const video = $("#video");
async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    return setStatus("Camera access needs HTTPS or localhost. Open the GitHub Pages link (https://) and try again.", "error");
  }
  setStatus("Requesting camera permission…", "loading");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
    video.srcObject = stream; await video.play();
    $("#cam-start").disabled = true; $("#cam-stop").disabled = false;
    setStatus("Point the camera at a QR code.", "loading");
    raf = requestAnimationFrame(tick);
  } catch (err) {
    const m = {
      NotAllowedError: "Camera permission was denied. Allow camera access in your browser's site settings, then try again.",
      NotFoundError: "No camera was found on this device. Use Upload QR instead.",
      NotReadableError: "The camera is in use by another app. Close it and try again.",
    }[err.name] || "The camera could not be started (" + err.name + ").";
    setStatus(m, "error"); stopCamera(true);
  }
}
function tick() {
  if (!stream) return;
  if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth) {
    const c = document.createElement("canvas"); c.width = video.videoWidth; c.height = video.videoHeight;
    c.getContext("2d", { willReadFrequently: true }).drawImage(video, 0, 0);
    const thumb = makeThumb(c, c.width, c.height), codes = decodeCanvasAll(c);
    if (codes.length) { stopCamera(); setStatus(""); return finishScan(codes, thumb, thumb); }
  }
  raf = requestAnimationFrame(tick);
}
function stopCamera(keepStatus) {
  cancelAnimationFrame(raf);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null; video.srcObject = null;
  $("#cam-start").disabled = false; $("#cam-stop").disabled = true;
  if (!keepStatus && $("#status").classList.contains("loading")) setStatus("");
}
$("#cam-start").addEventListener("click", startCamera);
$("#cam-stop").addEventListener("click", () => stopCamera());

/* ---------- Module 2: Classification ---------- */
function parseWifi(raw) {
  const body = raw.slice(5), out = {}; let cur = "", parts = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\" && i + 1 < body.length) { cur += body[++i]; continue; }
    if (body[i] === ";") { parts.push(cur); cur = ""; } else cur += body[i];
  }
  if (cur) parts.push(cur);
  parts.forEach((p) => { const k = p.slice(0, p.indexOf(":")), v = p.slice(p.indexOf(":") + 1); if (k) out[k.toUpperCase()] = v; });
  return out;
}
function maskRaw(raw) { return /^WIFI:/i.test(raw) ? raw.replace(/(P:)((?:\\.|[^;\\])*)/i, "$1••••••••") : raw; }

const DANGEROUS_SCHEMES = ["javascript:", "data:", "file:", "vbscript:", "blob:", "intent:"];

function classify(raw) {
  const s = raw.trim(), r = { raw, details: [], sensitive: [], url: null };
  const set = (type, intent, precautions) => Object.assign(r, { type, intent, precautions });
  let m;
  if (/^WIFI:/i.test(s)) {
    const w = parseWifi(s);
    set("Wi-Fi credentials", "Joins a Wi-Fi network using the name and password stored in the code.",
      ["Join only networks you recognise and trust.", "Treat the password as private; anyone with this QR can read it.", "Avoid sensitive logins on open (no-password) networks."]);
    r.details = [["Network (SSID)", w.S || "—"], ["Security", w.T || "none"], ["Password", w.P ? "••••••••" : "(none)", "secret", w.P], ["Hidden network", w.H === "true" ? "Yes" : "No"]];
    r.sensitive = w.P ? ["Wi-Fi password (masked)"] : [];
  } else if (/^upi:\/\//i.test(s)) {
    let q = new URLSearchParams(s.split("?")[1] || "");
    set("UPI payment link", "Opens a UPI app to pay the listed payee. It may prefill an amount.",
      ["Check the payee name and UPI ID in your UPI app before you confirm.", "Never enter your UPI PIN to receive money; a PIN is only for paying.", "Be careful if a stranger or unexpected sign asked you to scan."]);
    r.details = [["Payee UPI ID", q.get("pa") || "—"], ["Payee name", q.get("pn") || "—"], ["Amount", q.get("am") ? q.get("am") + " " + (q.get("cu") || "INR") : "Not set"], ["Note", q.get("tn") || "—"]];
    r.sensitive = ["Payee UPI ID", "Payment amount"];
  } else if (/^tel:/i.test(s)) {
    set("Phone number", "Starts a phone call to this number.", ["Do not call numbers from unknown sources, as premium-rate and scam numbers exist."]);
    r.details = [["Number", s.slice(4)]]; r.sensitive = ["Phone number"];
  } else if (/^mailto:/i.test(s)) {
    const a = s.slice(7).split("?"), q = new URLSearchParams(a[1] || "");
    set("Email address", "Opens your email app with a new message.", ["Check the address before you send anything.", "Do not send personal or financial details."]);
    r.details = [["To", decodeURIComponent(a[0])], ["Subject", q.get("subject") || "—"], ["Body", q.get("body") || "—"]]; r.sensitive = ["Email address"];
  } else if ((m = s.match(/^smsto?:([^:?]*)[:?]?(.*)$/i))) {
    set("SMS link", "Opens a text message addressed to a number, possibly with prefilled text.", ["Read the prefilled message before sending.", "Texts to short codes can trigger paid subscriptions."]);
    r.details = [["To", m[1] || "—"], ["Message", m[2].replace(/^body=/i, "") || "—"]]; r.sensitive = ["Phone number"];
  } else if (/^BEGIN:VCARD/i.test(s)) {
    const g = (k) => (s.match(new RegExp("^" + k + "[^:\\n]*:(.*)$", "im")) || [])[1] || "—";
    set("Contact information (vCard)", "Adds a contact card to your address book.", ["Save contacts only from sources you trust.", "Check the name against the number and email before saving."]);
    r.details = [["Name", g("FN")], ["Phone", g("TEL")], ["Email", g("EMAIL")], ["Organisation", g("ORG")], ["URL", g("URL")]];
    r.sensitive = ["Personal contact details"];
  } else if ((m = s.match(/^geo:(-?[\d.]+),(-?[\d.]+)/i))) {
    set("Geographic location", "Opens a map at the listed coordinates.", ["Confirm the place is real before you travel to an unfamiliar location."]);
    r.details = [["Latitude", m[1]], ["Longitude", m[2]]]; r.sensitive = ["Location"];
  } else if (/^https?:\/\//i.test(s) || DANGEROUS_SCHEMES.some((d) => s.toLowerCase().startsWith(d)) || /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\.?([/?#]\S*)?$/i.test(s)) {
    set("Website URL", "Opens a web page in your browser. QR Shield never opens it for you.",
      ["Check the domain name letter by letter.", "Do not enter passwords or payment details on pages you reached from an unknown QR.", "Be cautious with downloads and permission requests."]);
    r.url = s;
  } else if (/^\+?[\d\s\-().]{6,20}$/.test(s)) {
    set("Phone number", "A bare phone number, usually dialled or saved by your scanner app.", ["Verify who the number belongs to before calling."]);
    r.details = [["Number", s]]; r.sensitive = ["Phone number"];
  } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) {
    set("Email address", "A bare email address.", ["Check the address before you write to it."]);
    r.details = [["Email", s]]; r.sensitive = ["Email address"];
  } else if (/^[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]+$/.test(s)) {
    set("Plain text", "Shows text. Nothing is opened or run.", ["Read the text carefully. Text can still contain links or instructions meant to trick you."]);
    r.details = [["Length", s.length + " characters"]];
    const link = s.match(/https?:\/\/[^\s]+/i); if (link) { r.url = link[0]; r.details.push(["Link found in text", link[0]]); }
  } else {
    set("Unknown format", "The data is not in a format QR Shield recognises.", ["Do not act on data you cannot identify."]);
    r.details = [["Length", s.length + " characters"]];
  }
  return r;
}

/* ---------- Module 3: Local URL analysis ---------- */
const BRANDS = ["paypal", "google", "microsoft", "apple", "amazon", "facebook", "instagram", "whatsapp", "netflix", "paytm", "phonepe", "gpay", "npci", "sbi", "hdfc", "icici", "irctc"];
const SHORTENERS = ["bit.ly", "tinyurl.com", "t.co", "goo.gl", "is.gd", "cutt.ly", "ow.ly", "rb.gy", "shorturl.at", "tiny.cc"];
const RISKY_TLDS = ["zip", "mov", "tk", "ml", "ga", "cf", "gq", "top", "xyz", "click", "country", "work", "support"];
const KEYWORDS = ["login", "signin", "verify", "secure", "account", "update", "confirm", "wallet", "bank", "password", "otp", "kyc", "refund", "prize"];
const SECOND_LEVEL = ["co", "com", "org", "net", "gov", "ac", "edu"];

function analyzeUrl(input) {
  const out = { analyzed: true, score: 0, indicators: [], info: {} };
  const add = (pts, sev, text) => { out.score += pts; out.indicators.push({ sev, text }); };
  let s = input.trim();
  const low = s.toLowerCase();
  const bad = DANGEROUS_SCHEMES.find((d) => low.startsWith(d));
  if (bad) {
    out.info = { Scheme: bad, Host: "—", "URL length": s.length };
    add(5, "high", `Uses the "${bad}" scheme, which can run code or load local content instead of opening a website.`);
    return finish(out);
  }
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) { s = "http://" + s; out.indicators.push({ sev: "info", text: "No scheme in the QR data; treated as an unencrypted http:// link." }); out.score += 1; }
  let u;
  try { u = new URL(s); } catch (e) { return { analyzed: false, score: 0, indicators: [{ sev: "info", text: "The URL could not be parsed, so no checks were possible." }], info: {}, reasons: ["The text is not a valid URL."] }; }
  if (!/^https?:$/.test(u.protocol)) add(3, "high", `Uses the uncommon scheme "${u.protocol}" instead of http or https.`);
  const host = u.hostname.toLowerCase().replace(/\.$/, ""), labels = host.split(".");
  const tld = labels[labels.length - 1];
  const lastTwo = labels.slice(-2).join(".");
  const regLabels = labels.length >= 3 && SECOND_LEVEL.includes(labels[labels.length - 2]) && tld.length === 2 ? 3 : 2;
  const registered = labels.slice(-regLabels).join(".");
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || /^0x[0-9a-f]+$/i.test(host) || /^\d{8,10}$/.test(host);
  out.info = { Scheme: u.protocol.replace(":", ""), Host: host, "Registered domain": isIp ? "n/a (IP address)" : registered, Subdomains: isIp ? "—" : (labels.slice(0, -regLabels).join(".") || "none"), Path: u.pathname + u.search || "/", "URL length": s.length };

  if (u.protocol === "http:") add(1, "med", "Uses http, so the connection is not encrypted.");
  if (u.username || u.password) add(3, "high", "Contains embedded credentials (user@host). Attackers use this to disguise the real destination.");
  if (isIp) add(3, "high", "The host is an IP address instead of a domain name.");
  if (s.length > 200) add(2, "med", `Very long URL (${s.length} characters).`); else if (s.length > 100) add(1, "med", `Long URL (${s.length} characters).`);
  if (!isIp) {
    if (labels.length - regLabels >= 3) add(1, "med", `Many subdomain levels (${labels.length - regLabels}), which can hide the real domain.`);
    if (host.split("-").length > 3) add(1, "med", "The hostname contains many hyphens.");
    if (host.includes("xn--")) add(2, "high", "Uses punycode (xn--), which can show lookalike characters from other alphabets.");
    if (/[^\x00-\x7F]/.test(input)) add(2, "high", "Contains non-ASCII characters that can imitate familiar letters.");
    if (RISKY_TLDS.includes(tld)) add(1, "med", `The ".${tld}" top-level domain is commonly abused, though many legitimate sites use it.`);
    const regLabel = registered.split(".")[0];
    const brand = BRANDS.find((b) => host.includes(b) && regLabel !== b);
    if (brand) add(3, "high", `The hostname mentions "${brand}" but the registered domain is "${registered}". This is a common impersonation pattern.`);
    const kw = KEYWORDS.filter((k) => host.includes(k));
    if (kw.length) add(1, "med", `The hostname contains sensitive-sounding words: ${kw.join(", ")}.`);
    if (SHORTENERS.includes(registered)) add(2, "med", "Link shortener: the real destination is hidden until opened.");
  }
  if (/%[0-9a-f]{2}/i.test(u.pathname + u.search + u.hostname)) {
    const n = (u.href.match(/%[0-9a-f]{2}/gi) || []).length;
    add(n > 5 ? 2 : 1, "med", `Contains ${n} percent-encoded character(s).`);
  }
  if (/@/.test(u.pathname + u.search)) add(1, "med", 'Contains "@" in the path or query.');
  if (/[?&](url|redirect|redir|next|continue|goto)=https?/i.test(u.search)) add(1, "med", "Contains a redirect parameter that points to another site.");
  if (!out.indicators.some((i) => i.sev !== "info")) out.indicators.push({ sev: "info", text: "None of the local pattern checks were triggered." });
  return finish(out);
}
function finish(out) {
  out.risk = out.score >= 4 ? "HIGH" : out.score >= 2 ? "MEDIUM" : "LOW";
  out.reasons = out.indicators.filter((i) => i.sev !== "info").map((i) => i.text);
  if (out.risk === "LOW") out.reasons = ["No suspicious patterns were found by the local checks. This does not prove the site is safe."];
  return out;
}

/* Future integration: Google Safe Browsing through YOUR secure backend.
   Never place an API key in this file. Set endpoint to a backend URL that holds the key,
   accepts POST {url} and returns JSON {verdict: "SAFE"|"UNSAFE"|"UNKNOWN", details?: string}. */
const ThreatIntel = {
  endpoint: null,
  isConfigured() { return !!this.endpoint; },
  async check(url) {
    if (!this.isConfigured()) return { status: "not_configured" };
    const res = await fetch(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    if (!res.ok) throw new Error("Threat intelligence backend returned " + res.status);
    return { status: "checked", ...(await res.json()) };
  },
};

/* ---------- Scan pipeline ---------- */
let session = [];   // entries from the latest scan
let current = 0;
async function finishScan(codes, thumb) {
  setStatus("Analysing…", "loading");
  session = [];
  for (const raw of codes) {
    const c = classify(raw);
    let url = null;
    const a = c.url ? analyzeUrl(c.url) : null;
    if (a && a.analyzed) url = a;
    let verification = "Not verified. No threat-intelligence service is connected; only local pattern checks were run.";
    if (c.url && ThreatIntel.isConfigured()) {
      try { const t = await ThreatIntel.check(c.url); verification = "Backend verdict: " + (t.verdict || "UNKNOWN"); } catch (e) { verification = "Verification failed: " + e.message; }
    }
    let risk = "UNVERIFIED", reasons, indicators;
    if (url) { risk = url.risk; reasons = url.reasons; indicators = url.indicators; }
    else if (c.url) { reasons = ["The link could not be analysed."]; indicators = []; }
    else { reasons = ["Local URL checks apply only to links. This content type cannot be verified here."]; indicators = []; }
    session.push({ id: Date.now() + "-" + session.length, time: new Date().toISOString(), raw: c.raw, type: c.type, intent: c.intent, details: c.details.map((d) => d.slice(0, 3)), sensitive: c.sensitive, precautions: c.precautions, urlInfo: url ? url.info : null, indicators, reasons, risk, verification, thumb, urlChecked: c.url });
  }
  session.forEach((e) => history.unshift({ ...e, details: e.details.map((d) => [d[0], d[1], d[2]]) }));
  saveHistory(); current = 0; setStatus("");
  renderReport(); renderLists(); showView("analysis");
  if (codes.length > 1) toast(codes.length + " QR codes found in this image.");
}

/* ---------- Report rendering ---------- */
function recommend(e) {
  if (e.risk === "HIGH") return "Do not open this link or enter any information. If it came from a flyer, poster or message you did not expect, report it.";
  if (e.risk === "MEDIUM") return "Open it only if you trust where the QR code came from. Check the full address first and never enter passwords or payment details.";
  if (e.risk === "LOW") return "Local checks found no warning signs, but nothing was verified against threat databases. Still confirm the QR code came from a trusted place.";
  return "This content cannot be verified here. Follow the precautions listed and act only if you trust its source.";
}
function renderReport() {
  const box = $("#report");
  if (!session.length) {
    box.innerHTML = '<div class="glass card"><p>No report yet. Scan a QR code to see its safety analysis.</p><button class="btn primary" data-go="scan">Scan QR</button></div>';
    $("[data-go]", box).addEventListener("click", () => showView("scan")); return;
  }
  const e = session[current];
  const tabs = session.length > 1 ? '<div class="qr-tabs">' + session.map((_, i) => `<button class="tab ${i === current ? "active" : ""}" data-i="${i}">QR ${i + 1}</button>`).join("") + "</div>" : "";
  const det = e.details.map((d) => `<dt>${esc(d[0])}</dt><dd>${esc(d[1])}${d[2] === "secret" ? ' <button class="reveal" data-secret="1">Show</button>' : ""}</dd>`).join("");
  const ui = e.urlInfo ? Object.entries(e.urlInfo).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") : "";
  const ind = e.indicators.length ? e.indicators.map((i) => `<li class="sev-${i.sev}">${esc(i.text)}</li>`).join("") : "<li>No URL indicators apply to this content.</li>";
  box.innerHTML = `${tabs}
  <div class="banner r-${e.risk}"><b>${RISK_LABEL[e.risk]}</b><p>${esc(recommend(e))}</p></div>
  <div class="grid2">
    <div class="glass card"><h2>QR image</h2><img class="thumb" src="${esc(e.thumb)}" alt="Scanned QR preview"></div>
    <div class="glass card"><h2>Classification</h2><dl class="kv"><dt>Category</dt><dd>${esc(e.type)}</dd><dt>Intended action</dt><dd>${esc(e.intent)}</dd><dt>Scanned</dt><dd>${esc(new Date(e.time).toLocaleString())}</dd></dl></div>
  </div>
  <div class="glass card"><h2>Extracted content</h2><div class="code" id="raw">${esc(maskRaw(e.raw))}</div>${/^WIFI:/i.test(e.raw) ? '<p class="hint">The Wi-Fi password is masked. Copy still copies the full content.</p>' : ""}
    ${det ? `<dl class="kv" style="margin-top:.8rem">${det}</dl>` : ""}
    ${e.sensitive.length ? `<p class="hint">Potentially sensitive: ${esc(e.sensitive.join(", "))}</p>` : ""}</div>
  ${ui ? `<div class="glass card"><h2>URL and domain information</h2><dl class="kv">${ui}</dl></div>` : ""}
  <div class="grid2">
    <div class="glass card"><h2>Suspicious indicators</h2><ul>${ind}</ul></div>
    <div class="glass card"><h2>Threat verification</h2><p>${esc(e.verification)}</p><h2>Why this rating</h2><ul>${e.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>
  </div>
  <div class="glass card"><h2>Recommended precautions</h2><ul>${e.precautions.map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>
  <div class="row"><button class="btn" id="copy">Copy extracted content</button><button class="btn" id="dl">Download report</button><button class="btn primary" id="again">Scan another QR</button></div>`;
  $$(".qr-tabs .tab", box).forEach((b) => b.addEventListener("click", () => { current = +b.dataset.i; renderReport(); }));
  $("#copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(e.raw); toast("Copied to clipboard"); } catch (err) { toast("Copy failed. Select the text manually."); }
  });
  $("#dl").addEventListener("click", () => downloadReport(e));
  $("#again").addEventListener("click", () => { setStatus(""); $("#preview-wrap").hidden = true; showView("scan"); });
  const rv = $(".reveal", box);
  if (rv) rv.addEventListener("click", () => {
    const row = rv.closest("dd"), pw = e.details.find((d) => d[2] === "secret");
    const shown = rv.textContent === "Hide";
    row.firstChild.textContent = shown ? "••••••••" : (parseWifi(e.raw).P || "(none)");
    $("#raw").textContent = shown ? maskRaw(e.raw) : e.raw; rv.textContent = shown ? "Show" : "Hide";
  });
}
function downloadReport(e) {
  const L = [
    "QR SHIELD – SAFETY REPORT", "=".repeat(30), "Generated: " + new Date(e.time).toLocaleString(), "",
    "Risk category: " + RISK_LABEL[e.risk], "Threat verification: " + e.verification, "",
    "Content category: " + e.type, "Intended action: " + e.intent, "", "Extracted content (sensitive values masked):", maskRaw(e.raw), "",
    ...e.details.map((d) => `${d[0]}: ${d[1]}`), "",
    e.urlInfo ? "URL / domain information:" : "", ...(e.urlInfo ? Object.entries(e.urlInfo).map(([k, v]) => `  ${k}: ${v}`) : []), "",
    "Suspicious indicators:", ...(e.indicators.length ? e.indicators.map((i) => "  - " + i.text) : ["  (none applicable)"]), "",
    "Reasons for classification:", ...e.reasons.map((r) => "  - " + r), "",
    "Recommended action: " + recommend(e), "", "Precautions:", ...e.precautions.map((p) => "  - " + p), "",
    "Note: local checks are heuristics and cannot prove a link is safe or malicious.",
  ];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([L.join("\n")], { type: "text/plain" }));
  a.download = "qr-shield-report-" + Date.now() + ".txt"; a.click(); URL.revokeObjectURL(a.href);
}

/* ---------- Lists and counters ---------- */
function listHtml(items) {
  if (!items.length) return '<li class="empty">No scans yet. Scan a QR code and it will appear here.</li>';
  return items.map((h) => `<li data-id="${esc(h.id)}"><img src="${esc(h.thumb)}" alt="" width="44" height="44" style="object-fit:cover;border-radius:6px;background:#fff"><div class="t"><b>${esc(maskRaw(h.raw))}</b><small>${esc(h.type)} · ${esc(new Date(h.time).toLocaleString())}</small></div><span class="badge r-${h.risk}">${RISK_LABEL[h.risk]}</span></li>`).join("");
}
function renderLists() {
  $("#stat-total").textContent = history.length;
  $("#stat-threat").textContent = history.filter((h) => h.risk === "HIGH").length;
  $("#stat-susp").textContent = history.filter((h) => h.risk === "MEDIUM").length;
  $("#recent-list").innerHTML = listHtml(history.slice(0, 5));
  $("#history-list").innerHTML = listHtml(history);
}
["#recent-list", "#history-list"].forEach((sel) => $(sel).addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-id]"); if (!li) return;
  const e = history.find((h) => h.id === li.dataset.id); if (!e) return;
  session = [e]; current = 0; renderReport(); showView("analysis");
}));
$("#clear-history").addEventListener("click", () => {
  if (!history.length || !confirm("Delete all scan history from this browser?")) return;
  history = []; saveHistory(); renderLists(); toast("History cleared");
});

if (typeof jsQR === "undefined") setStatus("The QR decoder library failed to load. Check your internet connection and reload.", "error");
renderLists(); renderReport();
