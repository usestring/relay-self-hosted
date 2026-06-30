/// <reference path="../pb_data/types.d.ts" />

routerAdd("POST", "/api/accept-invitation", (c) => {
	try {
		const info = $apis.requestInfo(c);
		if (!info.authRecord) return c.json(401, { error: "Unauthorized" });

		const key = info.data.key;
		const userId = info.authRecord.id;
		if (typeof key !== "string" || !/^[A-Za-z0-9_-]+$/.test(key)) {
			return c.json(400, { error: "Missing key" });
		}

		let invitation;
		try {
			invitation = $app.dao().findFirstRecordByFilter(
				"relay_invitations",
				"key = {:key} && enabled = true",
				{ key },
			);
		} catch (e) {
			return c.json(404, { error: "Invitation not found or disabled" });
		}

		const relayId = invitation.get("relay");
		try {
			$app.dao().findFirstRecordByFilter(
				"relay_roles",
				"user = {:user} && relay = {:relay}",
				{ user: userId, relay: relayId },
			);
		} catch (e) {
			const relayRolesCol = $app.dao().findCollectionByNameOrId("relay_roles");
			const role = new Record(relayRolesCol);
			role.set("user", userId);
			role.set("relay", relayId);
			role.set("role", invitation.get("role") || "rolemember00000");
			$app.dao().saveRecord(role);
		}

		const relay = $app.dao().findRecordById("relays", relayId);
		return c.json(200, relay);
	} catch (e) {
		return c.json(500, { error: String(e && e.message ? e.message : e) });
	}
}, $apis.requireRecordAuth());

function rotateInvitationKey(c) {
	try {
		const info = $apis.requestInfo(c);
		const user = info.authRecord;
		if (!user) {
			return c.json(401, { error: "Unauthorized" });
		}

		const data = info.data || {};
		if (typeof data.id !== "string" || !/^[A-Za-z0-9_-]+$/.test(data.id)) {
			return c.json(400, { error: "id required" });
		}

		const dao = $app.dao();
		const invitation = dao.findRecordById("relay_invitations", data.id);
		const relay = dao.findRecordById("relays", invitation.get("relay"));
		if (!relay || relay.getString("creator") !== user.id) {
			return c.json(403, { error: "relay owner required" });
		}

		invitation.set(
			"key",
			$security.randomStringWithAlphabet(
				32,
				"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
			),
		);
		invitation.set("enabled", true);
		dao.saveRecord(invitation);
		$apis.enrichRecord(c, dao, invitation, "relay");
		return c.json(200, invitation);
	} catch (e) {
		return c.json(500, { error: String(e && e.message ? e.message : e) });
	}
}

routerAdd(
	"POST",
	"/api/self-host-rotate-key",
	rotateInvitationKey,
	$apis.requireRecordAuth(),
);

function relayToml(c) {
	try {
		const info = $apis.requestInfo(c);
		const user = info.authRecord;
		if (!user) {
			return c.json(401, { error: "Unauthorized" });
		}

		let relayId;
		try {
			relayId = c.pathParam("id");
		} catch (e) {
			return c.json(400, { error: "relay id required" });
		}
		if (typeof relayId !== "string" || !/^[A-Za-z0-9_-]+$/.test(relayId)) {
			return c.json(400, { error: "relay id required" });
		}

		const dao = $app.dao();
		const relay = dao.findRecordById("relays", relayId);
		if (!relay || relay.getString("creator") !== user.id) {
			return c.json(403, { error: "relay owner required" });
		}

		const providerId = relay.get("provider");
		const provider = providerId ? dao.findRecordById("providers", providerId) : null;
		const url = provider ? provider.getString("url") : "http://localhost:8080";
		const body = [
			"[server]",
			`url = "${url}"`,
			"",
			"[[auth]]",
			'public_key = "<paste relay-server EdDSA public_key>"',
			'key_id = "self_hosted_eddsa"',
			'key_type = "EdDSA"',
			'allowed_token_types = ["document", "file", "server", "prefix"]',
			"",
			"[[auth]]",
			'private_key = "<paste 30-byte legacy signing key from ./keygen.sh>"',
			'key_id = "self_hosted_legacy"',
			'key_type = "hmac-sha256"',
			'allowed_token_types = ["document", "file", "server", "prefix"]',
			"",
		].join("\n");

		return c.string(200, body);
	} catch (e) {
		return c.json(500, { error: String(e && e.message ? e.message : e) });
	}
}

routerAdd(
	"GET",
	"/api/self-host-relay-toml/:id",
	relayToml,
	$apis.requireRecordAuth(),
);
