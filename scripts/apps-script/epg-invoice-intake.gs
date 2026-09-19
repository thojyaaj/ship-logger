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
 *
 * Signing must match lib/invoice-audit/intake-auth.ts exactly — change both
 * together.
 */

var CALLER_ID = "gmail-apps-script";
var INTAKE_PATH = "/api/v1/invoices/epg";
var DONE_LABEL = "ShipLogger/Audited";
var REJECTED_LABEL = "ShipLogger/Rejected";
// Each post can take up to ~60s server-side; Apps Script stops a run at
// 6 minutes. Anything left over is picked up next hour.
var MAX_MESSAGES_PER_RUN = 4;

function processEpgInvoices() {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = requiredProp_(props, "SHIPLOGGER_URL").replace(/\/+$/, "");
  var secret = requiredProp_(props, "INVOICE_INTAKE_SECRET");
  var sender = requiredProp_(props, "EPG_SENDER");

  var done = labelFor_(DONE_LABEL);
  var rejected = labelFor_(REJECTED_LABEL);
  var query =
    "from:" + sender + " has:attachment filename:xlsx " +
    '-label:"' + DONE_LABEL + '" -label:"' + REJECTED_LABEL + '" newer_than:60d';

  var threads = GmailApp.search(query, 0, 20);
  var processed = 0;

  for (var t = 0; t < threads.length && processed < MAX_MESSAGES_PER_RUN; t++) {
    var thread = threads[t];
    var threadOk = true;
    var threadRejected = false;
    var messages = thread.getMessages();

    for (var m = 0; m < messages.length && processed < MAX_MESSAGES_PER_RUN; m++) {
      var message = messages[m];
      if (message.getFrom().toLowerCase().indexOf(sender.toLowerCase()) === -1) continue;
      var attachments = message.getAttachments().filter(function (a) {
        return /\.xlsx$/i.test(a.getName());
      });
      if (attachments.length === 0) continue;
      processed++;

      for (var a = 0; a < attachments.length; a++) {
        var result = postInvoice_(baseUrl, secret, attachments[a], message.getId());
        if (result === "rejected") threadRejected = true;
        else if (result !== "ok") threadOk = false;
      }
    }

    // Only a fully handled thread gets labeled — anything transient is left
    // unlabeled so the next run retries it (the server dedupes on invoice
    // number, so re-sending one that already went through is harmless).
    // Also unlabeled if this run's cap cut the thread off partway through.
    if (m < messages.length) threadOk = false;
    if (threadOk) thread.addLabel(threadRejected ? rejected : done);
  }
}

/** @return {"ok"|"rejected"|"retry"} */
function postInvoice_(baseUrl, secret, attachment, messageId) {
  var bytes = attachment.getBytes();
  var timestamp = String(Math.floor(Date.now() / 1000));
  var bodyHash = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  var canonical = ["POST", INTAKE_PATH, timestamp, bodyHash].join("\n");
  var signature = toHex_(Utilities.computeHmacSha256Signature(canonical, secret, Utilities.Charset.UTF_8));

  var response = UrlFetchApp.fetch(baseUrl + INTAKE_PATH, {
    method: "post",
    contentType: "application/octet-stream",
    payload: bytes,
    muteHttpExceptions: true,
    headers: {
      "X-ShipLogger-Caller": CALLER_ID,
      "X-ShipLogger-Timestamp": timestamp,
      "X-ShipLogger-Signature": signature,
      // ASCII-only so the header is always valid; the name is informational.
      "X-ShipLogger-Filename": attachment.getName().replace(/[^\x20-\x7E]/g, "_"),
      "X-ShipLogger-Message-Id": messageId,
    },
  });

  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code === 200) {
    console.log("Audited " + attachment.getName() + ": " + text);
    return "ok";
  }
  if (code === 422) {
    // Not an invoice the parser understands — retrying won't change that.
    console.warn("Rejected " + attachment.getName() + ": " + text);
    return "rejected";
  }
  console.error("Intake failed for " + attachment.getName() + " (HTTP " + code + "): " + text);
  return "retry";
}

/** Run once by hand after setup: installs the hourly trigger (replacing any old one). */
function installHourlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === "processEpgInvoices") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("processEpgInvoices").timeBased().everyHours(1).create();
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
