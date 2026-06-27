/// <reference path="../pb_data/types.d.ts" />

// The plugin reads `authStoreModel.picture` (a URL string from the OAuth
// provider) in LoginManager.createUserFromOAuth. PocketBase's default `users`
// auth collection ships `name` + a file-type `avatar` field, but not a text
// `picture`, so add it. (`email` and `name` already exist on the auth
// collection, so they are not re-added here.)

migrate(
	(db) => {
		const dao = new Dao(db);
		const users = dao.findCollectionByNameOrId("users");

		if (!users.schema.getFieldByName("picture")) {
			users.schema.addField(
				new SchemaField({
					name: "picture",
					type: "text",
					required: false,
					options: { min: null, max: null, pattern: "" },
				}),
			);
			dao.saveCollection(users);
		}
	},
	(db) => {
		const dao = new Dao(db);
		const users = dao.findCollectionByNameOrId("users");
		const field = users.schema.getFieldByName("picture");
		if (field) {
			users.schema.removeField(field.id);
			dao.saveCollection(users);
		}
	},
);
