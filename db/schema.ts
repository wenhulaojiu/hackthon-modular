import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 每位登录用户拥有独立的数据快照，revision 用于防止并发覆盖。
export const userStates = sqliteTable("user_states", {
  userId: text("user_id").primaryKey(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull().default(0),
  updatedAt: text("updated_at").notNull(),
});

// API 密钥仅以 AES-GCM 密文保存，不进入前端状态快照。
export const userSecrets = sqliteTable("user_secrets", {
  userId: text("user_id").primaryKey(),
  ciphertext: text("ciphertext").notNull(),
  nonce: text("nonce").notNull(),
  updatedAt: text("updated_at").notNull(),
});
