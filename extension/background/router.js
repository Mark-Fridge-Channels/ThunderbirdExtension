/**
 * Routes envelope by action to the correct handler. All handlers return
 * { success, result?, error? }; router wraps in { request_id, success, result, error }.
 */

import * as state from "./state.js";
import { validateEnvelope, getValidator } from "../shared/schemas.js";
import { makeResponse, makeError, CODES } from "../shared/errors.js";
import { handleSwitchAccount } from "../handlers/switchAccount.js";
import { handleSendEmail } from "../handlers/sendEmail.js";
import { handleOpenMessage } from "../handlers/openMessage.js";
import { handleStarMessage } from "../handlers/starMessage.js";
import { handleAddContact } from "../handlers/addContact.js";
import { handleForwardMessage } from "../handlers/forwardMessage.js";
import { handleReplyMessage } from "../handlers/replyMessage.js";
import { handleResolveMessage } from "../handlers/resolveMessage.js";

const HANDLERS = {
  switch_account_context: handleSwitchAccount,
  send_email: handleSendEmail,
  open_message: handleOpenMessage,
  star_message: handleStarMessage,
  add_contact: handleAddContact,
  forward_message: handleForwardMessage,
  reply_message: handleReplyMessage,
  resolve_message: handleResolveMessage,
};

export async function route(envelope) {
  const requestId = envelope?.request_id ?? "unknown";

  const envCheck = validateEnvelope(envelope);
  if (!envCheck.ok) {
    return makeResponse(
      requestId,
      false,
      null,
      makeError(CODES.VALIDATION, envCheck.error)
    );
  }

  const action = envelope.action;
  const payload = envCheck.payload;
  if (action == null || typeof action !== "string") {
    return makeResponse(
      requestId,
      false,
      null,
      makeError(CODES.VALIDATION, "action missing or invalid (ensure extension was reloaded after code change)")
    );
  }
  const validator = getValidator(action);
  const payloadCheck = validator(payload);
  if (!payloadCheck.ok) {
    return makeResponse(
      requestId,
      false,
      null,
      makeError(CODES.VALIDATION, payloadCheck.error)
    );
  }

  const handler = HANDLERS[action];
  if (!handler) {
    return makeResponse(
      requestId,
      false,
      null,
      makeError(CODES.UNKNOWN, `No handler for action: ${action}`)
    );
  }

  const context = state.getContext();
  const idempotencyKey = envelope.idempotency_key ?? null;

  try {
    const out = await handler({
      requestId,
      action,
      payload: payloadCheck.payload,
      context,
      idempotencyKey,
    });
    if (out.success && out.result) {
      return makeResponse(requestId, true, out.result, null);
    }
    return makeResponse(
      requestId,
      false,
      null,
      out.error ?? makeError(CODES.UNKNOWN, "Handler returned no error")
    );
  } catch (e) {
    return makeResponse(
      requestId,
      false,
      null,
      makeError(CODES.API_ERROR, e?.message ?? String(e), undefined)
    );
  }
}
