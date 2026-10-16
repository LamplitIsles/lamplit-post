import type { Config } from "./config";
import { Store } from "./store";
import { Service } from "./service";
import { Host, TransportFixture } from "./host";
import { serve } from "./http";
export async function start(config: Config, fixture?: TransportFixture) {
  const store = new Store(config);
  let service: Service | undefined, host: Host | undefined;
  try {
    service = new Service(store);
    host = new Host(service, fixture);
    await host.start();
    service.startDispatch();
    const http = await serve(service);
    const runningService = service,
      runningHost = host;
    return {
      store,
      service: runningService,
      host: runningHost,
      http,
      async stop() {
        try {
          await http.stop();
          await runningService.stop();
          await runningHost.stop();
        } finally {
          store.close();
        }
      },
    };
  } catch (e) {
    try {
      await service?.stop();
      await host?.stop();
    } finally {
      store.close();
    }
    throw e;
  }
}
