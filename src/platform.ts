import type { ContentV1, MessageV1 } from "../contracts/v1/index";
import type { AccountConfig, Scope } from "./config";
export interface Observation {
  native_id: string;
  conversation_native_id: string;
  conversation_type: "direct" | "group";
  sender: string;
  name?: string;
  conversation_name?: string;
  timestamp: number;
  content: ContentV1[];
  assets: MessageV1["assets"];
  mentions: string[];
  self_mentioned: boolean;
  reply_native_id?: string;
  mutation?: "edit" | "retraction";
  catchup: boolean;
}
export interface Platform {
  config: AccountConfig;
  readonly nativeUserId: string;
  ready: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  check(scope: Scope, signal: AbortSignal): Promise<void>;
  members(
    scope: Scope,
    signal: AbortSignal,
  ): Promise<{
    items: { native_id: string; name?: string }[];
    capability:
      "supported" | "unsupported" | "permission_required" | "unavailable";
  }>;
  send(
    scope: Scope,
    content: ContentV1,
    reply: MessageV1 | null,
    signal: AbortSignal,
    replySequence?: number,
    onDispatch?: () => void,
  ): Promise<string[]>;
}
