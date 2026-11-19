import { StatefulActor, type AlarmInfo } from "@telnyx/edge-runtime";

export interface HoldInfo {
  shelterId: string;
  bedId: string;
  createdAt: number;
  expiresAt: number;
  expires_in_minutes?: number;
}

interface HoldsByCaller {
  [callerId: string]: HoldInfo;
}

export interface ShelterSeed {
  id: string;
  name: string;
  address: string;
  totalBeds: number;
  directions: string;
  location?: string;
  initialHolds?: number;
}

type IndexFile = { shelters: ShelterSeed[] };

export class Shelter extends StatefulActor {
  async holdBed(
    callerId: string,
    holdMinutes: number
  ): Promise<{
    ok: boolean;
    reason?: string;
    hold?: HoldInfo;
    bedsAvailable?: number;
  }> {
    await this.ensureSeeded();
    const holds = await this.pruneExpired();
    const total = (await this.ctx.storage.get<number>("totalBeds")) ?? 0;
    if (total <= 0) return { ok: false, reason: "not_seeded" };
    const existing = holds[callerId];
    if (existing) {
      return {
        ok: false,
        reason: "already_holding",
        bedsAvailable: total - Object.keys(holds).length,
        hold: { ...existing, shelterId: this.ctx.id },
      };
    }
    if (Object.keys(holds).length >= total) {
      return { ok: false, reason: "no_beds", bedsAvailable: 0 };
    }
    const bedId = this.pickFreeBed(holds, total);
    const now = Date.now();
    const hold: HoldInfo = {
      shelterId: this.ctx.id,
      bedId,
      createdAt: now,
      expiresAt: now + holdMinutes * 60_000,
    };
    const next: HoldsByCaller = { ...holds, [callerId]: hold };
    await this.ctx.storage.put("holds", next);
    await this.writeHoldCache(callerId, hold);
    await this.publishSnapshot(next, total);
    await this.rearmAlarm(next);
    return {
      ok: true,
      hold: { ...hold, expires_in_minutes: holdMinutes },
      bedsAvailable: total - Object.keys(next).length,
    };
  }

  async holdFor(
    callerId: string
  ): Promise<{ hold: HoldInfo | null; bedsAvailable: number; expires_in_minutes: number | null }> {
    await this.ensureSeeded();
    const holds = await this.pruneExpired();
    const total = (await this.ctx.storage.get<number>("totalBeds")) ?? 0;
    const hold = holds[callerId] ?? null;
    return {
      hold,
      bedsAvailable: total - Object.keys(holds).length,
      expires_in_minutes: hold
        ? Math.max(1, Math.ceil((hold.expiresAt - Date.now()) / 60000))
        : null,
    };
  }

  async cancelHold(
    callerId: string
  ): Promise<{ ok: boolean; reason?: string; bedsAvailable?: number }> {
    await this.ensureSeeded();
    const holds = await this.pruneExpired();
    const total = (await this.ctx.storage.get<number>("totalBeds")) ?? 0;
    const existing = holds[callerId];
    if (!existing) return { ok: false, reason: "no_hold", bedsAvailable: total - Object.keys(holds).length };
    const { [callerId]: _removed, ...rest } = holds;
    await this.ctx.storage.put("holds", rest);
    await this.env.CACHE.delete(`hold/${callerId}`);
    await this.publishSnapshot(rest, total);
    await this.rearmAlarm(rest);
    return { ok: true, bedsAvailable: total - Object.keys(rest).length };
  }

  async state(): Promise<{
    shelterId: string;
    name?: string;
    address?: string;
    directions?: string;
    location?: string;
    totalBeds: number;
    bedsAvailable: number;
    freeBedIds: string[];
  }> {
    await this.ensureSeeded();
    const holds = await this.pruneExpired();
    const total = (await this.ctx.storage.get<number>("totalBeds")) ?? 0;
    const name = await this.ctx.storage.get<string>("name");
    const address = await this.ctx.storage.get<string>("address");
    const directions = await this.ctx.storage.get<string>("directions");
    const location = await this.ctx.storage.get<string>("location");
    return {
      shelterId: this.ctx.id,
      name,
      address,
      directions,
      location,
      totalBeds: total,
      bedsAvailable: total - Object.keys(holds).length,
      freeBedIds: this.freeBeds(holds, total),
    };
  }

  async extendHold(
    callerId: string,
    extendMinutes: number
  ): Promise<{ ok: boolean; reason?: string; hold?: HoldInfo; bedsAvailable?: number }> {
    await this.ensureSeeded();
    const holds = await this.pruneExpired();
    const total = (await this.ctx.storage.get<number>("totalBeds")) ?? 0;
    const existing = holds[callerId];
    if (!existing) return { ok: false, reason: "no_hold", bedsAvailable: total - Object.keys(holds).length };
    const extended: HoldInfo = {
      ...existing,
      expiresAt: existing.expiresAt + extendMinutes * 60_000,
    };
    const next: HoldsByCaller = { ...holds, [callerId]: extended };
    await this.ctx.storage.put("holds", next);
    await this.writeHoldCache(callerId, extended);
    await this.publishSnapshot(next, total);
    await this.rearmAlarm(next);
    return {
      ok: true,
      hold: { ...extended, expires_in_minutes: Math.max(1, Math.ceil((extended.expiresAt - Date.now()) / 60000)) },
      bedsAvailable: total - Object.keys(next).length,
    };
  }

  async resetHolds(
    initialHolds: number,
    seed?: { name?: string; address?: string; directions?: string; location?: string }
  ): Promise<{ ok: boolean; bedsAvailable: number }> {
    const total = (await this.ctx.storage.get<number>("totalBeds")) ?? 0;
    if (total <= 0) return { ok: false, bedsAvailable: 0 };
    if (seed?.name) await this.ctx.storage.put("name", seed.name);
    if (seed?.address) await this.ctx.storage.put("address", seed.address);
    if (seed?.directions) await this.ctx.storage.put("directions", seed.directions);
    if (seed?.location) await this.ctx.storage.put("location", seed.location);
    const now = Date.now();
    const holds: HoldsByCaller = {};
    for (let i = 1; i <= initialHolds; i++) {
      const anonId = `anon-${this.ctx.id}-${i}`;
      const hold: HoldInfo = {
        shelterId: this.ctx.id,
        bedId: `bed-${i}`,
        createdAt: now,
        expiresAt: now + 8 * 60 * 60_000,
      };
      holds[anonId] = hold;
      await this.writeHoldCache(anonId, hold);
    }
    await this.ctx.storage.put("holds", holds);
    await this.publishSnapshot(holds, total);
    await this.rearmAlarm(holds);
    return { ok: true, bedsAvailable: total - Object.keys(holds).length };
  }

  async alarm(info: AlarmInfo): Promise<void> {
    try {
      const holds = await this.pruneExpired();
      await this.rearmAlarm(holds);
    } catch (err) {
      console.error(
        JSON.stringify({ msg: "alarm-failed", retryCount: info.retryCount, error: String(err) })
      );
      await this.ctx.storage.setAlarm(Date.now() + 60_000);
    }
  }

  private async ensureSeeded(): Promise<void> {
    if (await this.ctx.storage.get<number>("totalBeds")) return;
    const index = await this.env.CACHE.get<IndexFile>("index/shelters", { type: "json" });
    if (!index) return;
    const seed = index.shelters.find((s) => s.id === this.ctx.id);
    if (!seed) return;
    await this.ctx.storage.put("name", seed.name);
    await this.ctx.storage.put("address", seed.address);
    await this.ctx.storage.put("directions", seed.directions);
    await this.ctx.storage.put("location", seed.location ?? "");
    await this.ctx.storage.put("totalBeds", seed.totalBeds);
    const now = Date.now();
    const holds: HoldsByCaller = {};
    for (let i = 1; i <= (seed.initialHolds ?? 0); i++) {
      const anonId = `anon-${this.ctx.id}-${i}`;
      const hold: HoldInfo = {
        shelterId: this.ctx.id,
        bedId: `bed-${i}`,
        createdAt: now,
        expiresAt: now + 8 * 60 * 60_000,
      };
      holds[anonId] = hold;
      await this.writeHoldCache(anonId, hold);
    }
    await this.ctx.storage.put("holds", holds);
    await this.publishSnapshot(holds, seed.totalBeds);
  }

  private async pruneExpired(): Promise<HoldsByCaller> {
    const holds = (await this.ctx.storage.get<HoldsByCaller>("holds")) ?? {};
    const now = Date.now();
    const expired = Object.entries(holds).filter(([, h]) => h.expiresAt <= now);
    if (expired.length === 0) return holds;
    const remaining: HoldsByCaller = {};
    for (const [callerId, hold] of Object.entries(holds)) {
      if (hold.expiresAt <= now) {
        await this.env.CACHE.delete(`hold/${callerId}`);
      } else {
        remaining[callerId] = hold;
      }
    }
    await this.ctx.storage.put("holds", remaining);
    await this.publishSnapshot(remaining, (await this.ctx.storage.get<number>("totalBeds")) ?? 0);
    return remaining;
  }

  private async publishSnapshot(holds: HoldsByCaller, total: number): Promise<void> {
    const name = await this.ctx.storage.get<string>("name");
    const address = await this.ctx.storage.get<string>("address");
    const location = await this.ctx.storage.get<string>("location");
    const directions = await this.ctx.storage.get<string>("directions");
    const snapshot = {
      shelterId: this.ctx.id,
      name,
      address,
      location,
      directions,
      totalBeds: total,
      bedsAvailable: total - Object.keys(holds).length,
      freeBedIds: this.freeBeds(holds, total),
      updatedAt: new Date().toISOString(),
    };
    await this.env.CACHE.put(`state/${this.ctx.id}`, JSON.stringify(snapshot));
  }

  private pickFreeBed(holds: HoldsByCaller, total: number): string {
    const used = new Set(Object.values(holds).map((h) => h.bedId));
    for (let i = 1; i <= total; i++) {
      const candidate = `bed-${i}`;
      if (!used.has(candidate)) return candidate;
    }
    return `bed-${total + 1}`;
  }

  private freeBeds(holds: HoldsByCaller, total: number): string[] {
    const used = new Set(Object.values(holds).map((h) => h.bedId));
    const free: string[] = [];
    for (let i = 1; i <= total; i++) {
      const candidate = `bed-${i}`;
      if (!used.has(candidate)) free.push(candidate);
    }
    return free;
  }

  private async writeHoldCache(callerId: string, hold: HoldInfo): Promise<void> {
    await this.env.CACHE.put(`hold/${callerId}`, JSON.stringify(hold));
  }

  private async rearmAlarm(holds: HoldsByCaller): Promise<void> {
    const times = Object.values(holds).map((h) => h.expiresAt);
    const target = times.length > 0 ? Math.min(...times) : null;
    const current = await this.ctx.storage.getAlarm();
    if (target === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }
}
