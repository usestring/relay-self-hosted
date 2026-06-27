/// <reference path="../pb_data/types.d.ts" />

// Custom route: POST /api/collections/relays/self-host
//
// Called by the plugin's RelayManager.createSelfHostedRelay() (triggered by the
// "Relay: Register self-hosted server" command). Body is one of:
//   { url: "http://localhost:8080" }   -> register a brand-new self-hosted host
//   { provider: "<providerId>" }       -> attach to an already-registered host
// optionally with { organization: "<id>" } (ignored here — no org/tenant model
// in this single-tenant self-host).
//
// relay.md keeps this route's implementation closed-source, so this is a
// best-effort reconstruction from the client contract: the plugin ingests the
// JSON response as a RelayDAO and immediately expects relay_roles_via_relay and
// storage_quota in `expand` (see RelayManager.createRelay's expand string and
// store.ingest). We therefore: find/create a provider, create the relay with
// the caller as creator, seed an Owner relay_role + a storage_quota, then return
// the relay enriched with those expands.
//
// Targets the PocketBase v0.22.x JS hooks API ($app.dao(), Record, $apis,
// $security). docker-compose pins the image version so this stays valid.

routerAdd(
	"POST",
	"/api/collections/relays/self-host",
	(c) => {
		const info = $apis.requestInfo(c);
		const user = info.authRecord;
		if (!user) {
			throw new UnauthorizedError("authentication required");
		}

		const data = info.data || {};
		const url = data.url;
		const providerId = data.provider;
		if (!url && !providerId) {
			throw new BadRequestError("either `url` or `provider` is required");
		}

		const dao = $app.dao();

		// uuid v4 (lowercase hex) — the relay guid becomes the y-doc namespace.
		const hex = (n) =>
			$security.randomStringWithAlphabet(n, "0123456789abcdef");
		const guid = `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[
			Math.floor(Math.random() * 4)
		]}${hex(3)}-${hex(12)}`;

		// --- resolve / create the provider --------------------------------
		let provider;
		if (providerId) {
			provider = dao.findRecordById("providers", providerId);
		} else {
			let host = url;
			try {
				host = new URL(url).host;
			} catch (e) {
				/* keep raw url as the display name */
			}
			const providersCol = dao.findCollectionByNameOrId("providers");
			provider = new Record(providersCol);
			provider.set("url", url);
			provider.set("name", host);
			provider.set("self_hosted", true);
			provider.set("key_type", "hmac-sha256");
			dao.saveRecord(provider);
		}

		// --- storage quota (defaults; metered off for self-host) ----------
		const quotaCol = dao.findCollectionByNameOrId("storage_quotas");
		const quota = new Record(quotaCol);
		quota.set("name", "self-hosted");
		quota.set("quota", 0);
		quota.set("usage", 0);
		quota.set("metered", false);
		quota.set("max_file_size", 0);
		dao.saveRecord(quota);

		// --- the relay ----------------------------------------------------
		const relaysCol = dao.findCollectionByNameOrId("relays");
		const relay = new Record(relaysCol);
		relay.set("guid", guid);
		relay.set("name", provider.getString("name") || "Self-hosted Relay");
		relay.set("version", 1);
		relay.set("path", "");
		relay.set("user_limit", 0);
		relay.set("creator", user.id);
		relay.set("provider", provider.id);
		relay.set("storage_quota", quota.id);
		relay.set("plan", "self-hosted");
		dao.saveRecord(relay);

		// --- Owner membership for the creator -----------------------------
		const rolesCol = dao.findCollectionByNameOrId("relay_roles");
		const relayRole = new Record(rolesCol);
		relayRole.set("user", user.id);
		relayRole.set("role", "roleowner000000"); // seeded Owner role id
		relayRole.set("relay", relay.id);
		dao.saveRecord(relayRole);

		// Enrich so the plugin's store.ingest sees the membership + quota it
		// expects right after creation (matches createRelay's expand string).
		$apis.enrichRecord(
			c,
			dao,
			relay,
			"relay_roles_via_relay",
			"relay_invitations_via_relay",
			"storage_quota",
		);

		return c.json(200, relay);
	},
	$apis.requireRecordAuth("users"),
);
