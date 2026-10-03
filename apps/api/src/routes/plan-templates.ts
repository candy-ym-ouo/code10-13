import type { FastifyPluginAsync } from "fastify";
import { planTemplateCreateSchema, planTemplateInstantiateSchema } from "@practice/contracts";
import { parseOrThrow } from "../lib/validation.js";
import { createTemplate, getTemplate, instantiateTemplate, listTemplates } from "../services/plan-service.js";

const planTemplateRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.authenticate);

  app.get("/", async (request) => {
    return listTemplates(request.authUser!.id);
  });

  app.post("/", async (request, reply) => {
    const input = parseOrThrow(planTemplateCreateSchema, request.body);
    const template = await createTemplate(request.authUser!.id, input);
    return reply.status(201).send({ template });
  });

  app.get("/:id", async (request) => {
    const { id } = request.params as { id: string };
    const template = await getTemplate(request.authUser!.id, id);
    return { template };
  });

  app.post("/:id/instantiate", async (request, reply) => {
    const { id } = request.params as { id: string };
    const input = parseOrThrow(planTemplateInstantiateSchema, request.body ?? {});
    const plan = await instantiateTemplate(request.authUser!.id, id, input);
    return reply.status(201).send({ plan });
  });
};

export default planTemplateRoutes;
