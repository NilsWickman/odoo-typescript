/**
 * Odoo's exception classes (`odoo/odoo/exceptions.py`) and their JSON-RPC rendering
 * (`odoo/odoo/http/dispatcher.py` JsonRPCDispatcher.handle_error, `odoo/odoo/service/model.py`).
 * The harness compares `error.data.name` and `error.data.message` (harness/NORMALIZATION.md N1); the `debug`
 * traceback compares by its last line only, so `debug` carries "<name>: <message>".
 */
export class OdooError extends Error {
  constructor(
    /** The Python dotted class name, e.g. "odoo.exceptions.AccessError". */
    readonly odooName: string,
    message: string,
    /** `arguments` of the Python exception: `[message]` unless the subclass adds more (RedirectWarning). */
    readonly args: unknown[] = [message],
    /** Extra keys for `error.data` (e.g. UnlinkBlockedError's payload). */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = odooName.split(".").pop() ?? odooName;
  }

  /** `error.data` of the JSON-RPC envelope. */
  data(): Record<string, unknown> {
    return {
      name: this.odooName,
      debug: `Traceback (most recent call last):\n${this.odooName}: ${this.message}\n`,
      message: this.message,
      arguments: this.args,
      context: {},
      ...this.extra,
    };
  }
}

export class UserError extends OdooError {
  constructor(message: string, args?: unknown[], extra?: Record<string, unknown>) {
    super("odoo.exceptions.UserError", message, args, extra);
  }
}

export class RedirectWarning extends OdooError {
  /**
   * `actionRepr` is Python's `str()` of the action: the JSON-RPC message is `exception_to_unicode` (odoo/loglevels.py:10),
   * the arguments joined with newlines (`additional_context` None by default).
   */
  constructor(message: string, action: unknown, buttonText: string, actionRepr: string, additionalContext: unknown = null) {
    super("odoo.exceptions.RedirectWarning", `${message}\n${actionRepr}\n${buttonText}\n${additionalContext === null ? "None" : "{}"}`,
      [message, action, buttonText, additionalContext]);
    if (additionalContext !== null) throw new NotPorted("RedirectWarning with an additional context (str of a dict)");
  }
}

export class AccessDenied extends OdooError {
  constructor(message = "Access Denied") {
    super("odoo.exceptions.AccessDenied", message);
  }
}

export class AccessError extends OdooError {
  /** `extra`: e.g. the `context` (suggested_company) of a record access error (ir_access.py:492). */
  constructor(message: string, extra: Record<string, unknown> = {}) {
    super("odoo.exceptions.AccessError", message, [message], extra);
  }
}

export class CacheMiss extends OdooError {
  constructor(message: string) {
    super("odoo.exceptions.CacheMiss", message);
  }
}

export class MissingError extends OdooError {
  constructor(message: string) {
    super("odoo.exceptions.MissingError", message);
  }
}

export class ValidationError extends OdooError {
  constructor(message: string) {
    super("odoo.exceptions.ValidationError", message);
  }
}

/** `werkzeug.exceptions.*` raised by controllers: rendered as plain HTTP errors, not JSON-RPC. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * `werkzeug.exceptions.HTTPException(response=...)` raised by a controller (web/controllers/report.py:147-155
 * `InternalServerError(response=res)`): the transaction rolls back and the given response is the answer.
 */
export class HttpResponseError extends Error {
  constructor(readonly response: Response) {
    super("HTTPException with a response");
    this.name = "HttpResponseError";
  }
}

/**
 * `SessionExpiredException` (odoo/odoo/http/session.py:84, re-exported by `odoo.http`): its module is
 * `odoo.http.session`, so the JSON-RPC error data name is "odoo.http.session.SessionExpiredException", the name the web
 * client opens its session-expired dialog on (web/static/src/core/errors/error_dialogs.js:327).
 */
export class SessionExpired extends OdooError {
  constructor(message = "Session expired") {
    super("odoo.http.session.SessionExpiredException", message);
  }
}

/** A route or feature the port does not implement yet. Strict runs count the exchange as "avviker". */
export class NotPorted extends Error {
  constructor(what: string) {
    super(`not ported: ${what}`);
    this.name = "NotPorted";
  }
}
