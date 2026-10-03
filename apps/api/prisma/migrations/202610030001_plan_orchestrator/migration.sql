-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'LOCKED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PlanOriginType" AS ENUM ('SCRATCH', 'TEMPLATE', 'PLAN_COPY', 'REVISION');

-- CreateTable
CREATE TABLE "plan_templates" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "goal" VARCHAR(300) NOT NULL,
    "description" TEXT,
    "source_plan_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_template_stages" (
    "id" UUID NOT NULL,
    "template_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "order" INTEGER NOT NULL,

    CONSTRAINT "plan_template_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_template_tasks" (
    "id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "detail" TEXT,
    "required_evidence" SMALLINT NOT NULL DEFAULT 1,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL,

    CONSTRAINT "plan_template_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "practice_plans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "goal" VARCHAR(300) NOT NULL,
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "origin_type" "PlanOriginType" NOT NULL DEFAULT 'SCRATCH',
    "origin_template_id" UUID,
    "origin_plan_id" UUID,
    "origin_plan_version" INTEGER,
    "locked_at" TIMESTAMPTZ(6),
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "practice_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_stages" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "order" INTEGER NOT NULL,
    "derived_from_stage_id" UUID,

    CONSTRAINT "plan_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_tasks" (
    "id" UUID NOT NULL,
    "stage_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "detail" TEXT,
    "required_evidence" SMALLINT NOT NULL DEFAULT 1,
    "weight" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "order" INTEGER NOT NULL,
    "derived_from_task_id" UUID,

    CONSTRAINT "plan_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_task_evidence" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "note" VARCHAR(500),
    "inherited_from_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_task_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "plan_templates_user_id_created_at_idx" ON "plan_templates"("user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "plan_template_stages_template_id_order_idx" ON "plan_template_stages"("template_id", "order");

-- CreateIndex
CREATE INDEX "plan_template_tasks_stage_id_order_idx" ON "plan_template_tasks"("stage_id", "order");

-- CreateIndex
CREATE INDEX "practice_plans_user_id_status_updated_at_idx" ON "practice_plans"("user_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "practice_plans_origin_plan_id_idx" ON "practice_plans"("origin_plan_id");

-- CreateIndex
CREATE INDEX "plan_stages_plan_id_order_idx" ON "plan_stages"("plan_id", "order");

-- CreateIndex
CREATE INDEX "plan_tasks_stage_id_order_idx" ON "plan_tasks"("stage_id", "order");

-- CreateIndex
CREATE UNIQUE INDEX "plan_task_evidence_task_id_media_id_key" ON "plan_task_evidence"("task_id", "media_id");

-- CreateIndex
CREATE INDEX "plan_task_evidence_plan_id_idx" ON "plan_task_evidence"("plan_id");

-- AddForeignKey
ALTER TABLE "plan_templates" ADD CONSTRAINT "plan_templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_templates" ADD CONSTRAINT "plan_templates_source_plan_id_fkey" FOREIGN KEY ("source_plan_id") REFERENCES "practice_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_template_stages" ADD CONSTRAINT "plan_template_stages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "plan_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_template_tasks" ADD CONSTRAINT "plan_template_tasks_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "plan_template_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_plans" ADD CONSTRAINT "practice_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_plans" ADD CONSTRAINT "practice_plans_origin_template_id_fkey" FOREIGN KEY ("origin_template_id") REFERENCES "plan_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_plans" ADD CONSTRAINT "practice_plans_origin_plan_id_fkey" FOREIGN KEY ("origin_plan_id") REFERENCES "practice_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_stages" ADD CONSTRAINT "plan_stages_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "practice_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_stage_id_fkey" FOREIGN KEY ("stage_id") REFERENCES "plan_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_task_evidence" ADD CONSTRAINT "plan_task_evidence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_task_evidence" ADD CONSTRAINT "plan_task_evidence_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "practice_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_task_evidence" ADD CONSTRAINT "plan_task_evidence_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "plan_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_task_evidence" ADD CONSTRAINT "plan_task_evidence_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_task_evidence" ADD CONSTRAINT "plan_task_evidence_inherited_from_id_fkey" FOREIGN KEY ("inherited_from_id") REFERENCES "plan_task_evidence"("id") ON DELETE SET NULL ON UPDATE CASCADE;
