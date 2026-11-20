import {
  type BeginUnitOfWork,
  type Clock,
  ConstraintViolation,
  forbidden,
  invalid,
  newId,
  notFound,
} from "@vibe/kernel";

import type { Caller } from "../domain/caller.ts";
import { parseHandle } from "../domain/handle.ts";
import { handleTaken } from "./identity-service.ts";
import type { IdentityRepository, Service } from "./ports.ts";
import { mintToken } from "./tokens.ts";

export interface CreatedService {
  service: Service;
  /** The secret, returned this once. */
  token: string;
}

const MAX_DESCRIPTION_LENGTH = 200;

/**
 * A team's services: machine principals with tokens of their own, for CI jobs
 * and workers. Anyone on the team can see them. Only a team owner adds one,
 * mints its tokens or removes it, since a service's token is a way in that no
 * person answers for.
 */
export class Services {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly begin: BeginUnitOfWork,
    private readonly clock: Clock,
  ) {}

  list(caller: Caller): Promise<Service[]> {
    return this.repository.listServices(caller.teamId);
  }

  /**
   * Adds a service and mints its first token. Its name is its handle, so it
   * must be free among the team's people and services, removed ones included.
   */
  async create(
    caller: Caller,
    input: { name: string; description?: string | undefined },
  ): Promise<CreatedService> {
    const { repository, begin, clock } = this;
    requireOwner(caller, "add a service");
    const name = parseHandle(input.name);
    const description = input.description?.trim() || null;
    if (description !== null && description.length > MAX_DESCRIPTION_LENGTH) {
      throw invalid(
        "invalid_service",
        `A service's description holds up to ${MAX_DESCRIPTION_LENGTH} characters.`,
      );
    }
    const taken =
      (await repository.findUserByHandle(caller.teamId, name)) ??
      (await repository.findServiceByName(caller.teamId, name, true));
    if (taken) throw handleTaken(name);

    const now = clock.now();
    const service: Service = {
      id: newId("s", now),
      teamId: caller.teamId,
      name,
      description,
      createdBy: caller.actorId,
      createdAt: now,
      removedAt: null,
    };
    const uow = begin();
    repository.addService(uow, service);
    const token = await mintToken(repository, uow, "service", service.id, "initial", now);
    try {
      await uow.commit();
    } catch (error) {
      // Someone took the handle between our read and our write.
      if (error instanceof ConstraintViolation) throw handleTaken(name);
      throw error;
    }
    return { service, token };
  }

  /** Mints another token for a service. Its earlier tokens keep working. */
  async mintToken(caller: Caller, name: string, label?: string | undefined): Promise<string> {
    const { repository, begin, clock } = this;
    requireOwner(caller, "mint a service's token");
    const service = await this.find(caller, name);
    const uow = begin();
    const token = await mintToken(
      repository,
      uow,
      "service",
      service.id,
      label ?? null,
      clock.now(),
    );
    await uow.commit();
    return token;
  }

  /**
   * Removes a service. Its tokens stop working from the next request, and its
   * schedules and watchers stop the next time they run. What it wrote stays,
   * under its name, which is never handed out again.
   */
  async remove(caller: Caller, name: string): Promise<Service> {
    const { repository, begin, clock } = this;
    requireOwner(caller, "remove a service");
    const service = await this.find(caller, name);
    const now = clock.now();
    const uow = begin();
    repository.removeService(uow, service, now);
    await uow.commit();
    return { ...service, removedAt: now };
  }

  private async find(caller: Caller, name: string): Promise<Service> {
    const service = await this.repository.findServiceByName(caller.teamId, parseHandle(name));
    if (!service) throw serviceNotFound(name);
    return service;
  }
}

function requireOwner(caller: Caller, what: string): void {
  if (caller.role === "owner") return;
  throw forbidden("forbidden", `Only a team owner can ${what}.`);
}

export const serviceNotFound = (name: string) =>
  notFound(
    "service_not_found",
    `This team has no service named ${name}.`,
    "`vibe services` lists them.",
  );
