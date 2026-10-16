import { Fault } from "./errors";
import { main } from "./cli";
main().catch((error) => {
  const category =
    error instanceof Fault
      ? error.message === "Incompatible state"
        ? "incompatible_state"
        : error.code
      : "invalid_or_unavailable";
  console.error("Post command failed: " + category + ". See operator guide.");
  process.exitCode = 1;
});
