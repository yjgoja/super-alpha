/**
 * Optional standalone tick loop: npm run engine
 */
import { runEngineTick } from "../src/lib/engine";

async function loop() {
  for (;;) {
    try {
      await runEngineTick();
      console.log("tick", new Date().toISOString());
    } catch (e) {
      console.error(e);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

loop();
