// Storage is handled directly in routes.ts via the existing SQLite DB.
// See server/db.ts for the database connection.
export interface IStorage {}
export class Storage implements IStorage {}
export const storage = new Storage();
