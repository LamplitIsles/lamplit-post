import type { Context } from "@koishijs/core";
import type { Database } from "minato";
export interface Tables {
  post_vault: {
    ref: string;
    account: string;
    kind: string;
    key_id: string;
    nonce: ArrayBuffer;
    tag: ArrayBuffer;
    cipher: ArrayBuffer;
  };
  post_tokens: { agent: string; digest: string };
  post_identities: { account: string; platform: string; native: string };
  post_conversations: {
    seq: number;
    id: string;
    account: string;
    native: string;
    type: "direct" | "group";
    name: string | null;
  };
  post_messages: {
    seq: number;
    id: string;
    account: string;
    conversation: string;
    native: string;
    sender: string;
    body: string;
  };
  post_assets: {
    id: string;
    owner: string | null;
    metadata: string;
    storage: string | null;
  };
  post_message_assets: { asset: string; message: string };
  post_deliveries: {
    seq: number;
    id: string;
    binding: string;
    agent: string;
    message: string;
    receiver: string;
    body: string;
    state: string;
    attempt: number;
    due: number;
    category: string | null;
  };
  post_sends: {
    agent: string;
    request: string;
    input: string;
    result: string | null;
  };
  post_reply_sequences: { account: string; native: string; sequence: number };
  post_gaps: { seq: number; account: string; category: string; at: number };
}
export type PostDatabase = Database<Tables>;
export function models(ctx: Context) {
  const db = ctx.model as unknown as PostDatabase;
  db.extend(
    "post_vault",
    {
      ref: "string",
      account: "string",
      kind: "string",
      key_id: "string",
      nonce: "binary",
      tag: "binary",
      cipher: "binary",
    },
    { primary: "ref" },
  );
  db.extend(
    "post_tokens",
    { agent: "string", digest: "string" },
    { primary: "agent", unique: ["digest"] },
  );
  db.extend(
    "post_identities",
    { account: "string", platform: "string", native: "string" },
    { primary: "account" },
  );
  db.extend(
    "post_conversations",
    {
      seq: "unsigned",
      id: "string",
      account: "string",
      native: "string",
      type: "string",
      name: { type: "string", initial: null },
    },
    {
      primary: "seq",
      autoInc: true,
      unique: ["id", ["account", "native", "type"]],
    },
  );
  db.extend(
    "post_messages",
    {
      seq: "unsigned",
      id: "string",
      account: "string",
      conversation: "string",
      native: "string",
      sender: "string",
      body: "text",
    },
    {
      primary: "seq",
      autoInc: true,
      unique: ["id", ["account", "conversation", "native"]],
    },
  );
  db.extend(
    "post_assets",
    {
      id: "string",
      owner: { type: "string", initial: null },
      metadata: "text",
      storage: { type: "string", initial: null },
    },
    { primary: "id" },
  );
  db.extend(
    "post_message_assets",
    { asset: "string", message: "string" },
    { primary: ["asset", "message"] },
  );
  db.extend(
    "post_deliveries",
    {
      seq: "unsigned",
      id: "string",
      binding: "string",
      agent: "string",
      message: "string",
      receiver: "string",
      body: "text",
      state: { type: "string", initial: "pending" },
      attempt: { type: "unsigned", initial: 0 },
      due: { type: "double", initial: 0 },
      category: { type: "string", initial: null },
    },
    { primary: "seq", autoInc: true, unique: ["id"] },
  );
  db.extend(
    "post_sends",
    {
      agent: "string",
      request: "string",
      input: "text",
      result: { type: "text", initial: null },
    },
    { primary: ["agent", "request"] },
  );
  db.extend(
    "post_reply_sequences",
    { account: "string", native: "string", sequence: "unsigned" },
    { primary: ["account", "native"] },
  );
  db.extend(
    "post_gaps",
    { seq: "unsigned", account: "string", category: "string", at: "double" },
    { primary: "seq", autoInc: true },
  );
}
