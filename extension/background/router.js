/**
 * Bridge V1 router: camelCase actions only.
 */

import { validateEnvelope, getValidator } from "../shared/schemas.js";
import { makeResponse, makeError, CODES } from "../shared/errors.js";
import { handleListAccounts } from "../handlers/listAccounts.js";
import { handleSendEmail } from "../handlers/sendEmail.js";
import { handleReplyEmail } from "../handlers/replyEmail.js";
import { handleFindMessages } from "../handlers/findMessages.js";
import { handleRestoreToInbox } from "../handlers/restoreToInbox.js";

const HANDLERS = {
  listAccounts: handleListAccounts,
  sendEmail: handleSendEmail,
  replyEmail: handleReplyEmail,
  findMessages: handleFindMessages,
  restoreToInbox: handleRestoreToInbox,
};

export async function route(envelope) {
  const requestId = envelope?.request_id ?? "unknown";

  const envCheck = validateEnvelope(envelope);
  if (!envCheck.ok) {
    return makeResponse(requestId, false, null, makeError(CODES.VALIDATION, envCheck.error));
  }

  const action = envelope.action;
  const payload = envCheck.payload;
  if (action == null || typeof action !== "string") {
    return makeResponse(
      requestId,
      false,
      null,
      makeError(CODES.VALIDATION, "action missing or invalid")
    );
  }
  const validator = getValidator(action);
  const payloadCheck = validator(payload);
  if (!payloadCheck.ok) {
    return makeResponse(requestId, false, null, makeError(CODES.VALIDATION, payloadCheck.error));
  }

  const handler = HANDLERS[action];
  if (!handler) {
    return makeResponse(requestId, false, null, makeError(CODES.UNKNOWN, `No handler for action: ${action}`));
  }

  try {
    const out = await handler({ requestId, payload: payloadCheck.payload });
    if (out.success && out.result !== undefined) {
      return makeResponse(requestId, true, out.result, null);
    }
    if (out.success && out.result === undefined) {
      return makeResponse(requestId, true, null, null);
    }
    return makeResponse(requestId, false, null, out.error ?? makeError(CODES.UNKNOWN, "Handler returned no error"));
  } catch (e) {
    return makeResponse(requestId, false, null, makeError(CODES.API_ERROR, e?.message ?? String(e), undefined));
  }
}
