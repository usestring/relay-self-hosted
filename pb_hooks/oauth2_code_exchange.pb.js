/// <reference path="../pb_data/types.d.ts" />

// Global middleware: persist OAuth2 authorization codes from the provider
// redirect so the plugin's manual code-exchange login flow can complete.
//
// Why this exists
// ---------------
// LoginManager has two OAuth paths against AUTH_URL (PocketBase):
//   1. Popup flow  — login() -> pb.collection("users").authWithOAuth2(); the PB
//      SDK opens a popup, subscribes to realtime, and PB's built-in
//      /api/oauth2-redirect handler relays the code back over SSE.
//   2. Manual flow — initiateManualOAuth2CodeFlow() opens the provider auth URL
//      itself, then poll() polls a server-written row:
//          pb.collection("code_exchange").getOne(provider.info.state.slice(0,15))
//      and on success calls provider.login(response.code) ->
//          authWithOAuth2Code(name, code, codeVerifier, redirectUrl).
//      (see relay-plugin/src/LoginManager.ts: poll() ~L547, loginFunction ~L497)
//
// The manual flow has no realtime subscriber, so nothing writes the code_exchange
// row on its own — without this handler poll() spins for 30s and times out
// ("Auth timeout"). relay.md's hosted PocketBase ships a closed redirect handler
// that writes that row; this is the self-host reconstruction.
//
// How
// ---
// Both flows use redirect_uri = {AUTH_URL}/api/oauth2-redirect (pb.buildUrl in
// LoginManager getWebviewIntercepts/initiateManualOAuth2CodeFlow). When the
// provider redirects the browser there it carries ?state=<state>&code=<code>.
// We can't routerAdd that path (it's a built-in route — re-adding conflicts), so
// we register global middleware that, for exactly that GET, upserts a
// code_exchange record keyed by state.slice(0,15) with the auth code, then calls
// next(c) so PB's built-in handler still runs and the popup/SSE flow is intact.
//
// PocketBase v0.22.x echo JS API (c.path()/c.queryParam(), $app.dao(), Record).
// docker-compose pins the image version so this API stays valid.

routerUse((next) => {
	return (c) => {
		// c.path() is the matched route pattern; only act on the OAuth redirect.
		if (c.path() !== "/api/oauth2-redirect") {
			return next(c);
		}

		const state = c.queryParam("state");
		const code = c.queryParam("code");

		// PocketBase record ids are exactly 15 chars and the plugin keys the row
		// by state.slice(0,15) (LoginManager.poll). A state shorter than 15 chars
		// can't produce a valid id and isn't something PB's own flow generates, so
		// skip rather than write an invalid record.
		if (state && code && state.length >= 15) {
			const id = state.substring(0, 15);
			try {
				const dao = $app.dao();
				let rec;
				try {
					// Idempotent: the same redirect may be retried by the browser.
					rec = dao.findRecordById("code_exchange", id);
				} catch (e) {
					const col = dao.findCollectionByNameOrId("code_exchange");
					rec = new Record(col);
					rec.setId(id);
				}
				rec.set("code", code);
				dao.saveRecord(rec);
			} catch (e) {
				// Never break the redirect render on a persistence failure — the
				// popup/SSE flow does not depend on this row.
				$app
					.logger()
					.error("oauth2 code_exchange persist failed", "error", String(e));
			}
		}

		return next(c);
	};
});
