import { useState, useEffect, useCallback } from "react";
import {
  fetchBusinessProjects,
  fetchBusinessProject,
  createBusinessProject,
  updateBusinessProject,
  archiveBusinessProject,
  createBusinessTask,
  updateBusinessTask,
  deleteBusinessTask,
  toggleBusinessTaskStatus,
  uploadTaskAttachment,
  deleteTaskAttachment,
  getTaskExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getProjectFinancials,
  type BusinessProject,
  type BusinessTask,
  type BusinessExpense,
  type ProjectFinancials,
} from "./bridge-api";

export function useBusiness() {
  const [projects, setProjects] = useState<BusinessProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchBusinessProjects();
      setProjects(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const addProject = useCallback(
    async (data: { name: string; description?: string; emoji?: string; color?: string }) => {
      const res = await createBusinessProject(data);
      await reload();
      return res.project;
    },
    [reload]
  );

  const editProject = useCallback(
    async (id: number, data: Partial<BusinessProject>) => {
      const res = await updateBusinessProject(id, data);
      await reload();
      return res.project;
    },
    [reload]
  );

  const removeProject = useCallback(
    async (id: number) => {
      await archiveBusinessProject(id);
      await reload();
    },
    [reload]
  );

  return { projects, loading, error, reload, addProject, editProject, removeProject };
}

export function useBusinessProject(id: number | null) {
  const [project, setProject] = useState<(BusinessProject & { tasks: BusinessTask[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!id) { setLoading(false); return; }
    try {
      setError(null);
      const data = await fetchBusinessProject(id);
      setProject(data as any);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  const uploadAttachment = useCallback(
    async (taskId: number, base64: string, fileName: string, fileType?: string) => {
      const res = await uploadTaskAttachment(taskId, base64, fileName, fileType);
      await reload();
      return res.attachment;
    },
    [reload]
  );

  const removeAttachment = useCallback(
    async (attachmentId: number) => {
      await deleteTaskAttachment(attachmentId);
      await reload();
    },
    [reload]
  );

  const addTask = useCallback(
    async (data: { title: string; description?: string; priority?: string; due_date?: string; phase?: string }) => {
      if (!id) return null;
      const res = await createBusinessTask(id, data);
      await reload();
      return res.task;
    },
    [id, reload]
  );

  const editTask = useCallback(
    async (taskId: number, data: Partial<BusinessTask>) => {
      const res = await updateBusinessTask(taskId, data);
      await reload();
      return res.task;
    },
    [reload]
  );

  const removeTask = useCallback(
    async (taskId: number) => {
      await deleteBusinessTask(taskId);
      await reload();
    },
    [reload]
  );

  const toggleTask = useCallback(
    async (taskId: number) => {
      const res = await toggleBusinessTaskStatus(taskId);
      // Optimistic: update local state immediately
      setProject((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          tasks: prev.tasks.map((t) => (t.id === taskId ? res.task : t)),
        };
      });
      return res.task;
    },
    []
  );

  const addExpense = useCallback(
    async (taskId: number, data: Partial<BusinessExpense>) => {
      const res = await createExpense(taskId, data);
      await reload();
      return res.expense;
    },
    [reload]
  );

  const editExpense = useCallback(
    async (expenseId: number, data: Partial<BusinessExpense>) => {
      const res = await updateExpense(expenseId, data);
      await reload();
      return res.expense;
    },
    [reload]
  );

  const removeExpense = useCallback(
    async (expenseId: number) => {
      await deleteExpense(expenseId);
      await reload();
    },
    [reload]
  );

  return { project, loading, error, reload, addTask, editTask, removeTask, toggleTask, uploadAttachment, removeAttachment, addExpense, editExpense, removeExpense };
}

export function useProjectFinancials(projectId: number | null) {
  const [financials, setFinancials] = useState<ProjectFinancials | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (!projectId) { setLoading(false); return; }
    try {
      const data = await getProjectFinancials(projectId);
      setFinancials(data);
    } catch {
      setFinancials(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setLoading(true);
    reload();
  }, [reload]);

  return { financials, loading, reload };
}
