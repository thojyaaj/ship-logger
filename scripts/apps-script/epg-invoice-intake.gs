/**
 * EPG invoice intake — Google Apps Script, runs inside the Gmail account
 * that receives EPG's invoice emails. Hourly, it finds new EPG emails with
 * an .xlsx attachment and posts each file to ship_logger's
 * POST /api/v1/invoices/epg, which audits it and emails a summary.
 *
 * This file is the reference copy kept in the repo; the live copy is pasted
 * into script.google.com. Setup steps: docs/invoice-audit.md.
 *
 * Script Properties (Project Settings → Script Properties):
 *   SHIPLOGGER_URL          e.g. https://ship.otcshoppeexpress.com
 *   INVOICE_INTAKE_SECRET   same value as Vercel's INVOICE_INTAKE_SECRET_GMAIL
 *   EPG_SENDER              the address EPG invoices come from
 *   LOOKBACK_DAYS           optional, default 60 — how far back to look
 *   DISPUTE_TO              optional — pre-fills "To" on dispute drafts
 *
 * Also a web app (doGet): ship_logger's "Create Gmail draft" button opens it
 * to draft a billing-dispute email to EPG with the report attached. Deploy
 * it as Execute as: Me, Who has access: Only myself — see the docs.
 *
 * Signing must match lib/invoice-audit/intake-auth.ts exactly — change both
 * together.
 */

var CALLER_ID = "gmail-apps-script";
var INTAKE_PATH = "/api/v1/invoices/epg";
var DISPUTE_PATH = "/api/v1/invoices/dispute-draft";
var DONE_LABEL = "ShipLogger/Audited";
var REJECTED_LABEL = "ShipLogger/Rejected";
var DEFAULT_LOOKBACK_DAYS = 60;
// Apps Script stops a run at 6 minutes and one post can take ~60s
// server-side, so no new post starts past this point. Anything left is
// picked up next run.
var RUN_BUDGET_MS = 4 * 60 * 1000;
// Handled message ids live in Script Properties, not in the Gmail labels:
// Gmail labels whole conversations, so if EPG's emails thread together, a
// label-based "skip what's done" would also skip a new invoice that lands
// in an already-labeled conversation. The labels are just for you to see.
var PROCESSED_KEY = "PROCESSED_MESSAGE_IDS";
var MAX_PROCESSED_IDS = 2000;

function processEpgInvoices() {
  var started = Date.now();
  var props = PropertiesService.getScriptProperties();
  var baseUrl = requiredProp_(props, "SHIPLOGGER_URL").replace(/\/+$/, "");
  var secret = requiredProp_(props, "INVOICE_INTAKE_SECRET");
  var sender = requiredProp_(props, "EPG_SENDER");
  var lookbackDays = Number(props.getProperty("LOOKBACK_DAYS")) || DEFAULT_LOOKBACK_DAYS;

  var processed = loadProcessed_(props);
  var done = labelFor_(DONE_LABEL);
  var rejected = labelFor_(REJECTED_LABEL);

  var pending = findInvoiceMessages_(sender, lookbackDays);
  var total = pending.length;
  pending = pending.filter(function (item) {
    return !processed[item.message.getId()];
  });
  console.log(
    "Found " + total + " EPG invoice email(s) from " + sender + " in the last " + lookbackDays + " days; " +
      (total - pending.length) + " already handled, " + pending.length + " to send."
  );

  var counts = { created: 0, duplicate: 0, rejected: 0, failed: 0 };
  var sent = 0;
  for (var i = 0; i < pending.length; i++) {
    if (Date.now() - started > RUN_BUDGET_MS) break;
    var item = pending[i];
    var messageOk = true;
    var messageRejected = false;

    for (var a = 0; a < item.attachments.length; a++) {
      var result = postInvoice_(baseUrl, secret, item.attachments[a], item.message.getId());
      counts[result]++;
      if (result === "rejected") messageRejected = true;
      else if (result === "failed") messageOk = false;
    }
    sent++;

    // A transient failure is left unrecorded so the next run retries it
    // (the server dedupes on invoice number, so a resend is harmless).
    if (messageOk) {
      processed[item.message.getId()] = true;
      saveProcessed_(props, processed);
      item.thread.addLabel(messageRejected ? rejected : done);
    }
  }

  console.log(
    "Done: " + counts.created + " audited, " + counts.duplicate + " already audited, " +
      counts.rejected + " rejected, " + counts.failed + " failed" +
      (sent < pending.length ? "; " + (pending.length - sent) + " left for the next run." : ".")
  );
}

/** Every message from EPG in the window with an .xlsx attachment, oldest first. */
function findInvoiceMessages_(sender, lookbackDays) {
  var query = "from:" + sender + " has:attachment filename:xlsx newer_than:" + lookbackDays + "d";
  var items = [];
  // GmailApp.search returns at most 500 threads per call — page through.
  for (var start = 0; ; start += 100) {
    var threads = GmailApp.search(query, start, 100);
    threads.forEach(function (thread) {
      thread.getMessages().forEach(function (message) {
        if (message.getFrom().toLowerCase().indexOf(sender.toLowerCase()) === -1) return;
        var attachments = message.getAttachments().filter(function (att) {
          return /\.xlsx$/i.test(att.getName());
        });
        if (attachments.length > 0) items.push({ thread: thread, message: message, attachments: attachments });
      });
    });
    if (threads.length < 100) break;
  }
  items.sort(function (x, y) {
    return x.message.getDate() - y.message.getDate();
  });
  return items;
}

/** @return {"created"|"duplicate"|"rejected"|"failed"} */
function postInvoice_(baseUrl, secret, attachment, messageId) {
  var response = signedPost_(baseUrl, secret, INTAKE_PATH, attachment.getBytes(), "application/octet-stream", {
    // ASCII-only so the header is always valid; the name is informational.
    "X-ShipLogger-Filename": attachment.getName().replace(/[^\x20-\x7E]/g, "_"),
    "X-ShipLogger-Message-Id": messageId,
  });

  var code = response.getResponseCode();
  var body = response.getContentText();
  // Capped: an error page (e.g. a 404) is a whole HTML document, which
  // floods the execution log.
  var text = body.slice(0, 300);
  if (code === 200) {
    var status = "created";
    try {
      status = JSON.parse(body).status === "duplicate" ? "duplicate" : "created";
    } catch (e) {}
    console.log((status === "duplicate" ? "Already audited " : "Audited ") + attachment.getName());
    return status;
  }
  if (code === 422) {
    // Not an invoice the parser understands — retrying won't change that.
    console.warn("Rejected " + attachment.getName() + ": " + text);
    return "rejected";
  }
  console.error("Intake failed for " + attachment.getName() + " (HTTP " + code + "): " + text);
  return "failed";
}

/**
 * POSTs `bytes` to ship_logger, HMAC-signed per lib/invoice-audit/intake-auth.ts:
 * method, path, timestamp and the body's SHA-256, one per line.
 */
function signedPost_(baseUrl, secret, path, bytes, contentType, extraHeaders) {
  var timestamp = String(Math.floor(Date.now() / 1000));
  var bodyHash = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  var canonical = ["POST", path, timestamp, bodyHash].join("\n");
  var signature = toHex_(Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8));
  var headers = {
    "X-ShipLogger-Caller": CALLER_ID,
    "X-ShipLogger-Timestamp": timestamp,
    "X-ShipLogger-Signature": signature,
  };
  Object.keys(extraHeaders || {}).forEach(function (k) {
    headers[k] = extraHeaders[k];
  });
  return UrlFetchApp.fetch(baseUrl + path, {
    method: "post",
    contentType: contentType,
    payload: bytes,
    muteHttpExceptions: true,
    headers: headers,
  });
}

/**
 * Web app entry point. ship_logger's "Create Gmail draft" button opens
 * <web app URL>?ids=<auditId>,<auditId>… in a new tab; this fetches the
 * dispute report for those invoices and saves a Gmail draft with the CSV
 * attached. Nothing is sent — you review and send the draft yourself.
 */
function doGet(e) {
  var ids = String((e && e.parameter && e.parameter.ids) || "")
    .split(",")
    .map(function (id) {
      return id.trim();
    })
    .filter(function (id) {
      return /^[0-9A-Za-z-]{1,64}$/.test(id);
    });
  if (ids.length === 0) return resultPage_("No invoices were selected.", null);

  try {
    var result = createDisputeDraft_(ids);
    return resultPage_(null, result);
  } catch (err) {
    return resultPage_("Couldn't create the draft: " + err.message, null);
  }
}

function createDisputeDraft_(ids) {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = requiredProp_(props, "SHIPLOGGER_URL").replace(/\/+$/, "");
  var secret = requiredProp_(props, "INVOICE_INTAKE_SECRET");

  var bytes = Utilities.newBlob(JSON.stringify({ ids: ids })).getBytes();
  var response = signedPost_(baseUrl, secret, DISPUTE_PATH, bytes, "application/json", {});
  var body = response.getContentText();
  if (response.getResponseCode() !== 200) {
    var message = "HTTP " + response.getResponseCode();
    try {
      message = JSON.parse(body).error || message;
    } catch (e) {}
    throw new Error(message);
  }

  var data = JSON.parse(body);
  var attachment = Utilities.newBlob(data.csv, "text/csv", data.fileName);
  var draft = GmailApp.createDraft(props.getProperty("DISPUTE_TO") || "", data.subject, data.text, {
    htmlBody: data.html,
    attachments: [attachment],
  });
  console.log("Created dispute draft: " + data.subject);
  return { draft: draft, subject: data.subject, fileName: data.fileName, parcelCount: data.parcelCount };
}

function resultPage_(error, result) {
  var draftsUrl = "https://mail.google.com/mail/u/0/#drafts";
  var html = error
    ? "<h2>Draft not created</h2><p>" + escapeHtml_(error) + "</p>"
    : "<h2>Gmail draft created</h2>" +
      "<p><strong>" + escapeHtml_(result.subject) + "</strong></p>" +
      "<p>" + result.parcelCount + " disputed parcel(s), with " + escapeHtml_(result.fileName) + " attached. " +
      "Review it, add the recipient if it's blank, and send it from Gmail.</p>" +
      '<p><a href="' + draftsUrl + '" target="_top">Open Gmail drafts</a></p>';
  return HtmlService.createHtmlOutput(
    '<div style="font-family:system-ui,sans-serif;max-width:560px;margin:40px auto;line-height:1.5">' + html + "</div>"
  ).setTitle("EPG dispute draft");
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}

/** Run once by hand after setup: installs the hourly trigger (replacing any old one). */
function installHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "processEpgInvoices") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("processEpgInvoices").timeBased().everyHours(1).create();
}

/** Run by hand to make the script send every invoice in the window again (the server skips ones already audited). */
function forgetProcessedEmails() {
  PropertiesService.getScriptProperties().deleteProperty(PROCESSED_KEY);
  console.log("Cleared the list of handled emails.");
}

function loadProcessed_(props) {
  var ids = JSON.parse(props.getProperty(PROCESSED_KEY) || "[]");
  var map = {};
  ids.forEach(function (id) {
    map[id] = true;
  });
  return map;
}

function saveProcessed_(props, map) {
  // Oldest ids drop off first — by then they're far outside any lookback.
  var ids = Object.keys(map).slice(-MAX_PROCESSED_IDS);
  props.setProperty(PROCESSED_KEY, JSON.stringify(ids));
}

function requiredProp_(props, name) {
  var value = props.getProperty(name);
  if (!value) throw new Error("Script property " + name + " is not set — see docs/invoice-audit.md");
  return value;
}

function labelFor_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function toHex_(bytes) {
  return bytes
    .map(function (b) {
      return ((b + 256) % 256).toString(16).padStart(2, "0");
    })
    .join("");
}
