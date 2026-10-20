/** Closed, content-free QQ ingress vocabulary. No external payload/error objects. */
export function qqInbound(record: {
  stage: "sdk_capture" | "observation" | "receiver";
  type: "group" | "direct";
  native_event?:
    | "GROUP_MESSAGE_CREATE"
    | "GROUP_AT_MESSAGE_CREATE"
    | "C2C_MESSAGE_CREATE"
    | "other";
  category:
    | "queued"
    | "stopped"
    | "capacity"
    | "capture_failed"
    | "archived"
    | "duplicate"
    | "self"
    | "catchup"
    | "observation_failed"
    | "accepted"
    | "http_rejected"
    | "unavailable"
    | "cancelled"
    | "scope_revoked"
    | "receiver_changed";
  bindings?: number;
  inactive?: number;
  disabled?: number;
  scope_missing?: number;
  peer_denied?: number;
  admitted?: number;
  wake_none?: number;
  wake_direct?: number;
  wake_mention?: number;
  wake_reply?: number;
  wake_alias?: number;
  deliveries_created?: number;
  http_status?: number | null;
  attempt?: number;
  elapsed_ms?: number;
}) {
  console.warn(JSON.stringify({ event: "qq_inbound", ...record }));
}
