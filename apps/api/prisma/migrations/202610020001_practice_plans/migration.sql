-- CreateEnum
CREATE TYPE "PlanStatus" AS ENUM ('DRAFT', 'ACTIVE', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "PlanTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED');

-- CreateTable
CREATE TABLE "practice_plans" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "goal_id" UUID,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "instrument" VARCHAR(60),
    "status" "PlanStatus" NOT NULL DEFAULT 'DRAFT',
    "is_template" BOOLEAN NOT NULL DEFAULT false,
    "version_chain_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL DEFAULT 1,
    "previous_version_id" UUID,
    "chain_head" BOOLEAN NOT NULL DEFAULT true,
    "locked_at" TIMESTAMPTZ(6),
    "change_note" VARCHAR(500),
    "copied_from_id" UUID,
    "root_ancestor_id" UUID,
    "total_tasks" INTEGER NOT NULL DEFAULT 0,
    "done_tasks" INTEGER NOT NULL DEFAULT 0,
    "skipped_tasks" INTEGER NOT NULL DEFAULT 0,
    "progress_pct" INTEGER NOT NULL DEFAULT 0,
    "recomputed_at" TIMESTAMPTZ(6),
    "start_date" DATE,
    "due_date" DATE,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "practice_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_phases" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "order_index" INTEGER NOT NULL,
    "total_tasks" INTEGER NOT NULL DEFAULT 0,
    "done_tasks" INTEGER NOT NULL DEFAULT 0,
    "skipped_tasks" INTEGER NOT NULL DEFAULT 0,
    "progress_pct" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_phases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_tasks" (
    "id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "phase_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "description" TEXT,
    "order_index" INTEGER NOT NULL,
    "status" "PlanTaskStatus" NOT NULL DEFAULT 'PENDING',
    "evidence_requirement" "EvidenceRequirement" NOT NULL DEFAULT 'NONE',
    "estimate_minutes" INTEGER,
    "due_date" DATE,
    "linked_goal_id" UUID,
    "self_review_note" TEXT,
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "plan_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plan_task_evidences" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "media_id" UUID NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "plan_task_evidences_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "practice_plans_user_id_status_updated_at_idx" ON "practice_plans"("user_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE INDEX "practice_plans_user_id_is_template_idx" ON "practice_plans"("user_id", "is_template");

-- CreateIndex
CREATE INDEX "practice_plans_user_id_chain_head_idx" ON "practice_plans"("user_id", "chain_head");

-- CreateIndex
CREATE INDEX "practice_plans_version_chain_id_version_number_idx" ON "practice_plans"("version_chain_id", "version_number");

-- CreateIndex
CREATE INDEX "practice_plans_copied_from_id_idx" ON "practice_plans"("copied_from_id");

-- CreateIndex
CREATE INDEX "practice_plans_root_ancestor_id_idx" ON "practice_plans"("root_ancestor_id");

-- CreateIndex
CREATE INDEX "plan_phases_plan_id_order_index_idx" ON "plan_phases"("plan_id", "order_index");

-- CreateIndex
CREATE INDEX "plan_tasks_phase_id_order_index_idx" ON "plan_tasks"("phase_id", "order_index");

-- CreateIndex
CREATE INDEX "plan_tasks_plan_id_status_idx" ON "plan_tasks"("plan_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "plan_task_evidences_task_id_media_id_key" ON "plan_task_evidences"("task_id", "media_id");

-- CreateIndex
CREATE INDEX "plan_task_evidences_plan_id_idx" ON "plan_task_evidences"("plan_id");

-- CreateIndex
CREATE INDEX "plan_task_evidences_user_id_created_at_idx" ON "plan_task_evidences"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "practice_plans" ADD CONSTRAINT "practice_plans_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "practice_plans" ADD CONSTRAINT "practice_plans_goal_id_fkey" FOREIGN KEY ("goal_id") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_phases" ADD CONSTRAINT "plan_phases_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "practice_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_phases" ADD CONSTRAINT "plan_phases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "practice_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_phase_id_fkey" FOREIGN KEY ("phase_id") REFERENCES "plan_phases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_linked_goal_id_fkey" FOREIGN KEY ("linked_goal_id") REFERENCES "goals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_task_evidences" ADD CONSTRAINT "plan_task_evidences_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "plan_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_task_evidences" ADD CONSTRAINT "plan_task_evidences_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "practice_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_task_evidences" ADD CONSTRAINT "plan_task_evidences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plan_task_evidences" ADD CONSTRAINT "plan_task_evidences_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_assets"("id") ON DELETE CASCADE ON UPDATE CASCADE;
