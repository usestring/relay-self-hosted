/// <reference path="../pb_data/types.d.ts" />

// Relay control-plane schema, reverse-engineered from the forked plugin's
// PocketBase usage (relay-plugin/src: RelayManager.ts, DeviceManager.ts,
// LoginManager.ts). Targets the PocketBase v0.22.x JS migration API
// (Dao / Collection / SchemaField). docker-compose pins the image version so
// this API stays valid — see README "PocketBase version pin".
//
// Field lists come from the DAO interfaces in RelayManager.ts:
//   RelayDAO, ProviderDAO, RemoteFolderDAO (shared_folders), RelayRoleDAO,
//   FolderRoleDAO (shared_folder_roles), RelayInvitationDAO, StorageQuotaDAO,
//   RelaySubscriptionDAO, plus devices/vaults (DeviceManager.ts) and
//   oauth2_response/code_exchange (LoginManager.ts).
//
// Realtime: the plugin opens collection(...).subscribe("*") on relays,
// relay_invitations, providers, relay_roles, shared_folders,
// shared_folder_roles, subscriptions — so each of those needs a listRule that
// is non-null (null = admin-only, blocks the SSE stream).

migrate(
	(db) => {
		const dao = new Dao(db);

		const TEXT = (name, required) =>
			new SchemaField({
				name,
				type: "text",
				required: !!required,
				options: { min: null, max: null, pattern: "" },
			});

		const NUMBER = (name) =>
			new SchemaField({
				name,
				type: "number",
				required: false,
				options: { min: null, max: null, noDecimal: false },
			});

		const BOOL = (name) =>
			new SchemaField({ name, type: "bool", required: false, options: {} });

		const JSONF = (name) =>
			new SchemaField({
				name,
				type: "json",
				required: false,
				options: { maxSize: 2000000 },
			});

		const REL = (name, targetName, opts) => {
			const target = dao.findCollectionByNameOrId(targetName);
			return new SchemaField({
				name,
				type: "relation",
				required: !!(opts && opts.required),
				options: {
					collectionId: target.id,
					cascadeDelete: !!(opts && opts.cascadeDelete),
					minSelect: null,
					maxSelect: 1,
					displayFields: null,
				},
			});
		};

		// Helper: create + save a base collection with explicit id so relations
		// and the self-host hook can reference it deterministically.
		const make = (id, name, fields, rules) => {
			const c = new Collection({
				id,
				name,
				type: "base",
				system: false,
				schema: fields,
				listRule: rules.list ?? null,
				viewRule: rules.view ?? rules.list ?? null,
				createRule: rules.create ?? null,
				updateRule: rules.update ?? null,
				deleteRule: rules.delete ?? null,
				indexes: rules.indexes ?? [],
			});
			dao.saveCollection(c);
			return c;
		};

		const AUTHED = '@request.auth.id != ""';
		const RELAY_MEMBER = 'relay.relay_roles_via_relay.user ?= @request.auth.id';
		const RELAY_MEMBER_OR_CREATOR = `relay.creator = @request.auth.id || ${RELAY_MEMBER}`;
		const FOLDER_MEMBER = 'shared_folder_roles_via_shared_folder.user ?= @request.auth.id';
		const FOLDER_RELAY_MEMBER = 'relay.relay_roles_via_relay.user ?= @request.auth.id';
		const FOLDER_VISIBLE = `creator = @request.auth.id || ${FOLDER_MEMBER} || (private = false && ${FOLDER_RELAY_MEMBER})`;
		const FOLDER_MANAGER = 'creator = @request.auth.id || relay.creator = @request.auth.id';

		// --- leaf collections (no relations) -------------------------------
		make("roles0000000000", "roles", [TEXT("name", true)], {
			list: AUTHED,
		});

		make(
			"storagequota000",
			"storage_quotas",
			[
				TEXT("name"),
				NUMBER("quota"),
				NUMBER("usage"),
				BOOL("metered"),
				NUMBER("max_file_size"),
			],
			{ list: AUTHED },
		);

		// providers: self-hosted endpoint certificates. public_key/key_type/key_id
		// describe the relay-server's token-signing key; self_hosted=true for ours.
		make(
			"providers000000",
			"providers",
			[
				TEXT("url"),
				TEXT("name"),
				BOOL("self_hosted"),
				TEXT("public_key"),
				TEXT("key_type"),
				TEXT("key_id"),
			],
			{ list: AUTHED },
		);

		// --- relays (references users / providers / storage_quotas) --------
		make(
			"relays000000000",
			"relays",
			[
				TEXT("guid", true),
				TEXT("name", true),
				NUMBER("version"),
				TEXT("path"),
				NUMBER("user_limit"),
				REL("creator", "users"),
				TEXT("cta"),
				TEXT("plan"),
				REL("provider", "providers"),
				REL("storage_quota", "storage_quotas"),
			],
			{
				// Visible to any member of the relay (via relay_roles back-relation)
				// or its creator. relay_roles_via_relay is PB's auto back-relation.
				list: 'creator = @request.auth.id || relay_roles_via_relay.user ?= @request.auth.id',
				create: 'creator = @request.auth.id',
				update: 'creator = @request.auth.id',
				delete: 'creator = @request.auth.id',
				indexes: [
					"CREATE UNIQUE INDEX idx_relays_guid ON relays (guid)",
				],
			},
		);

		// --- shared_folders (RemoteFolderDAO) ------------------------------
		make(
			"sharedfolders00",
			"shared_folders",
			[
				TEXT("guid", true),
				TEXT("name"),
				REL("creator", "users"),
				REL("relay", "relays", { cascadeDelete: true }),
				BOOL("private"),
			],
			{
				list: FOLDER_VISIBLE,
				create: `creator = @request.auth.id && ${FOLDER_RELAY_MEMBER}`,
				update: FOLDER_MANAGER,
				delete: FOLDER_MANAGER,
				indexes: [
					"CREATE UNIQUE INDEX idx_shared_folders_guid ON shared_folders (guid)",
				],
			},
		);

		// --- relay_roles (membership) --------------------------------------
		make(
			"relayroles00000",
			"relay_roles",
			[
				REL("user", "users"),
				REL("role", "roles"),
				REL("relay", "relays", { cascadeDelete: true }),
			],
			{
				list: `user = @request.auth.id || ${RELAY_MEMBER_OR_CREATOR}`,
				create: 'relay.creator = @request.auth.id',
				update: 'relay.creator = @request.auth.id',
				delete: 'relay.creator = @request.auth.id || user = @request.auth.id',
			},
		);

		// --- shared_folder_roles (FolderRoleDAO) ---------------------------
		make(
			"sharedfldroles0",
			"shared_folder_roles",
			[
				REL("user", "users"),
				REL("role", "roles"),
				REL("shared_folder", "shared_folders", { cascadeDelete: true }),
			],
			{
				list: `user = @request.auth.id || shared_folder.creator = @request.auth.id || shared_folder.relay.creator = @request.auth.id`,
				create: 'shared_folder.creator = @request.auth.id || shared_folder.relay.creator = @request.auth.id',
				update: 'shared_folder.creator = @request.auth.id || shared_folder.relay.creator = @request.auth.id',
				delete: 'shared_folder.creator = @request.auth.id || shared_folder.relay.creator = @request.auth.id || user = @request.auth.id',
			},
		);

		// --- relay_invitations (share keys) --------------------------------
		make(
			"relayinvites000",
			"relay_invitations",
			[
				REL("role", "roles"),
				REL("relay", "relays", { cascadeDelete: true }),
				TEXT("key"),
				BOOL("enabled"),
			],
			{
				list: RELAY_MEMBER_OR_CREATOR,
				create: 'relay.creator = @request.auth.id',
				update: 'relay.creator = @request.auth.id',
				delete: 'relay.creator = @request.auth.id',
			},
		);

		// --- subscriptions (RelaySubscriptionDAO) --------------------------
		// Referenced only via expand (subscriptions_via_relay). Stripe fields are
		// inert in self-host but kept so the plugin's expand/ingest doesn't choke.
		make(
			"subscriptions00",
			"subscriptions",
			[
				BOOL("active"),
				REL("user", "users"),
				REL("relay", "relays", { cascadeDelete: true }),
				NUMBER("stripe_cancel_at"),
				NUMBER("stripe_quantity"),
				TEXT("token"),
			],
			{
				list: `user = @request.auth.id || ${RELAY_MEMBER_OR_CREATOR}`,
			},
		);

		// --- devices (DeviceManager.registerDevice) ------------------------
		// id is client-supplied (15-char PB id); name == platform.
		make(
			"devices00000000",
			"devices",
			[TEXT("name"), TEXT("platform"), REL("user", "users")],
			{
				list: 'user = @request.auth.id',
				create: 'user = @request.auth.id',
				update: 'user = @request.auth.id',
				delete: 'user = @request.auth.id',
			},
		);

		// --- vaults (DeviceManager.registerVault) --------------------------
		// id is the Obsidian appId (client-supplied).
		make(
			"vaults000000000",
			"vaults",
			[REL("device", "devices"), REL("user", "users")],
			{
				list: 'user = @request.auth.id',
				create: 'user = @request.auth.id && device.user = @request.auth.id',
				update: 'user = @request.auth.id',
				delete: 'user = @request.auth.id',
			},
		);

		// --- oauth2_response (LoginManager.setup) --------------------------
		make(
			"oauth2response0",
			"oauth2_response",
			[REL("user", "users"), JSONF("oauth_response")],
			{
				list: 'user = @request.auth.id',
				create: AUTHED,
				update: 'user = @request.auth.id',
				delete: 'user = @request.auth.id',
			},
		);

		// --- code_exchange (LoginManager.poll) -----------------------------
		// Polled by getOne(state.slice(0,15)) during the *manual* OAuth code flow,
		// and populated server-side by pb_hooks/oauth2_code_exchange.pb.js (the
		// /api/oauth2-redirect middleware). poll() runs BEFORE the user is authed
		// (it is the login handshake), so viewRule MUST be public — with view:
		// AUTHED the anonymous getOne is forbidden, poll()'s .catch swallows it,
		// and login times out. The 15-char id is the high-entropy OAuth-state
		// slice, so view-by-id is the capability check; listRule stays null so
		// rows can't be enumerated. Rows are written via DAO (bypasses API rules),
		// so create/update/delete stay admin-only.
		make("codeexchange000", "code_exchange", [TEXT("code")], {
			view: "",
		});

		// --- seed the three role records the plugin checks by name ---------
		const rolesCol = dao.findCollectionByNameOrId("roles");
		[
			["roleowner000000", "Owner"],
			["rolemember00000", "Member"],
			["rolereader00000", "Reader"],
		].forEach(([id, name]) => {
			const r = new Record(rolesCol);
			r.setId(id);
			r.set("name", name);
			dao.saveRecord(r);
		});
	},
	(db) => {
		const dao = new Dao(db);
		[
			"code_exchange",
			"oauth2_response",
			"vaults",
			"devices",
			"subscriptions",
			"relay_invitations",
			"shared_folder_roles",
			"relay_roles",
			"shared_folders",
			"relays",
			"providers",
			"storage_quotas",
			"roles",
		].forEach((name) => {
			try {
				dao.deleteCollection(dao.findCollectionByNameOrId(name));
			} catch (e) {
				// already gone
			}
		});
	},
);
