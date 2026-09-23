import { SQLDatabase } from "encore.dev/storage/sqldb";

export const db = new SQLDatabase("tracks_db", { migrations: "./migrations" });
