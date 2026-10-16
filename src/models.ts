export interface Tables {
  vault: {
    ref: string;
    account: string;
    kind: string;
    key_id: string;
    nonce: Uint8Array;
    tag: Uint8Array;
    cipher: Uint8Array;
  };
  tokens: { agent: string; digest: string };
  identities: { account: string; platform: string; native: string };
  conversations: {
    seq: number;
    id: string;
    account: string;
    native: string;
    type: "direct" | "group";
    name: string | null;
  };
  messages: {
    seq: number;
    id: string;
    account: string;
    conversation: string;
    native: string;
    sender: string;
    body: string;
  };
  assets: {
    id: string;
    owner: string | null;
    metadata: string;
    storage: string | null;
  };
  message_assets: { asset: string; message: string };
  deliveries: {
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
  sends: {
    agent: string;
    request: string;
    input: string;
    result: string | null;
  };
  reply_sequences: { account: string; native: string; sequence: number };
  gaps: { seq: number; account: string; category: string; at: number };
}
