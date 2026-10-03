import type { FastifyPluginAsync } from "fastify";
import {
  planCopySchema,
  planCreateSchema,
  planEvidenceCreateSchema,
  planListQuerySchema,
  planSaveAsTemplateSchema,
  planStructureSchema,
  planUpdateSchema,
} from "@practice/contracts";
import { parseOrThrow } from "../lib/validation.js";
import { audit } from "../lib/audit.js";
import {
  addEvidence,
  copyPlan,
  createPlan,
  getPlan,
  getPlanLineage,
  getPlanProgress,
  listPlans,
  lockPlan,
  removeEvidence,
  replacePlanStructure,
  revisePlan,
  savePlanAsTemplate,
  updatePlan,
} from "../services/plan-service.js";

const planRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    const query = parseOrThrow(planListQuerySchema, request.query);
    return listPlans(request.authUser!.id, query);
  });

  app.post("/", async (request, reply) => {
    const input = parseOrThrow(planCreateSchema, request.body);
    const plan = await createPlan(request.authUser!.id, input);
    return reply.status(201).send({ plan });
  });

  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const plan = await getPlan(request.authUser!.id, id);
    return { plan };
  });

  app.patch("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(planUpdateSchema, request.body);
    const plan = await updatePlan(request.authUser!.id, id, input);
    return { plan };
  });

  app.put("/:id/structure", async (request) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(planStructureSchema, request.body);
    const plan = await replacePlanStructure(request.authUser!.id, id, input);
    return { plan };
  });

  app.post("/:id/lock", async (request) => {
    const { id } = request.params as { id: string };
    const plan = await lockPlan(request.authUser!.id, id);
    await audit(request, "PLAN_LOCKED", "PLAN", id, "SUCCESS");
    return { plan };
  });

  app.post("/:id/revise", async (request, reply) => {
    const { id } = request.params as { id: string };
    const plan = await revisePlan(request.authUser!.id, id);
    await audit(request, "PLAN_REVISED", "PLAN", plan.id, "SUCCESS", { fromPlanId: id, fromVersion: plan.version - 1 });
    return reply.status(201).send({ plan });
  });

  app.post("/:id/copy", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(planCopySchema, request.body ?? {});
    const plan = await copyPlan(request.authUser!.id, id, input);
    return reply.status(201).send({ plan });
  });

  app.post("/:id/save-as-template", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(planSaveAsTemplateSchema, request.body);
    const template = await savePlanAsTemplate(request.authUser!.id, id, input);
    return reply.status(201).send({ template });
  });

  app.get("/:id/progress", async (request) => {
    const { id } = request.params as { id: string };
    const progress = await getPlanProgress(request.authUser!.id, id);
    return { progress };
  });

  app.get("/:id/lineage", async (request) => {
    const { id } = request.params as { id: string };
    const data = await getPlanLineage(request.authUser!.id, id);
    return { data };
  });

  app.post("/:id/tasks/:taskId/evidence", async (request, reply) => {
    const { id, taskId } = request.params as { id: string; taskId: string };
    const input = parseOrThrow(planEvidenceCreateSchema, request.body);
    const evidence = await addEvidence(request.authUser!.id, id, taskId, input);
    return reply.status(201).send({ evidence });
  });

  app.delete("/:id/evidence/:evidenceId", async (request, reply) => {
    const { id, evidenceId } = request.params as { id: string; evidenceId: string };
    await removeEvidence(request.authUser!.id, id, evidenceId);
    return reply.status(204).send();
  });
};

export default planRoutes;
