import { StatefulActor } from "@telnyx/edge-runtime";

export class Counters extends StatefulActor {
  async bump(key: string, by = 1): Promise<number> {
    const counters = (await this.ctx.storage.get<Record<string, number>>("counters")) ?? {};
    const next = { ...counters, [key]: (counters[key] ?? 0) + by };
    await this.ctx.storage.put("counters", next);
    return next[key];
  }

  async snapshot(): Promise<Record<string, number>> {
    return (await this.ctx.storage.get<Record<string, number>>("counters")) ?? {};
  }
}
