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
  fetchBusinessContacts,
  createBusinessContact,
  updateBusinessContact,
  deleteBusinessContact,
  fetchBusinessShipments,
  createBusinessShipment,
  updateBusinessShipment,
  updateShipmentStatus,
  deleteBusinessShipment,
  fetchBusinessInvoices,
  createBusinessInvoice,
  updateBusinessInvoice,
  deleteBusinessInvoice,
  fetchBusinessInvestments,
  createBusinessInvestment,
  updateBusinessInvestment,
  deleteBusinessInvestment,
  fetchDashboardMetrics,
  type BusinessProject,
  type BusinessTask,
  type BusinessExpense,
  type ProjectFinancials,
  type BusinessContact,
  type BusinessShipment,
  type BusinessInvoice,
  type BusinessInvestment,
  type DashboardMetrics,
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

export function useContacts(filterType?: string) {
  const [contacts, setContacts] = useState<BusinessContact[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await fetchBusinessContacts(filterType);
      setContacts(data);
    } catch { setContacts([]); }
    finally { setLoading(false); }
  }, [filterType]);

  useEffect(() => { setLoading(true); reload(); }, [reload]);

  const add = useCallback(async (data: Partial<BusinessContact>) => {
    const res = await createBusinessContact(data);
    await reload();
    return res.contact;
  }, [reload]);

  const edit = useCallback(async (id: number, data: Partial<BusinessContact>) => {
    const res = await updateBusinessContact(id, data);
    await reload();
    return res.contact;
  }, [reload]);

  const remove = useCallback(async (id: number) => {
    await deleteBusinessContact(id);
    await reload();
  }, [reload]);

  return { contacts, loading, reload, add, edit, remove };
}

export function useShipments(filterStatus?: string) {
  const [shipments, setShipments] = useState<BusinessShipment[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await fetchBusinessShipments(filterStatus);
      setShipments(data);
    } catch { setShipments([]); }
    finally { setLoading(false); }
  }, [filterStatus]);

  useEffect(() => { setLoading(true); reload(); }, [reload]);

  const add = useCallback(async (data: Partial<BusinessShipment>) => {
    const res = await createBusinessShipment(data);
    await reload();
    return res.shipment;
  }, [reload]);

  const edit = useCallback(async (id: number, data: Partial<BusinessShipment>) => {
    const res = await updateBusinessShipment(id, data);
    await reload();
    return res.shipment;
  }, [reload]);

  const advanceStatus = useCallback(async (id: number, status: string) => {
    const res = await updateShipmentStatus(id, status);
    await reload();
    return res.shipment;
  }, [reload]);

  const remove = useCallback(async (id: number) => {
    await deleteBusinessShipment(id);
    await reload();
  }, [reload]);

  return { shipments, loading, reload, add, edit, advanceStatus, remove };
}

export function useInvoices(filterStatus?: string) {
  const [invoices, setInvoices] = useState<BusinessInvoice[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await fetchBusinessInvoices(filterStatus);
      setInvoices(data);
    } catch { setInvoices([]); }
    finally { setLoading(false); }
  }, [filterStatus]);

  useEffect(() => { setLoading(true); reload(); }, [reload]);

  const add = useCallback(async (data: Partial<BusinessInvoice>) => {
    const res = await createBusinessInvoice(data);
    await reload();
    return res.invoice;
  }, [reload]);

  const edit = useCallback(async (id: number, data: Partial<BusinessInvoice>) => {
    const res = await updateBusinessInvoice(id, data);
    await reload();
    return res.invoice;
  }, [reload]);

  const remove = useCallback(async (id: number) => {
    await deleteBusinessInvoice(id);
    await reload();
  }, [reload]);

  return { invoices, loading, reload, add, edit, remove };
}

export function useInvestments() {
  const [investments, setInvestments] = useState<BusinessInvestment[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await fetchBusinessInvestments();
      setInvestments(data);
    } catch { setInvestments([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { setLoading(true); reload(); }, [reload]);

  const add = useCallback(async (data: Partial<BusinessInvestment>) => {
    const res = await createBusinessInvestment(data);
    await reload();
    return res.investment;
  }, [reload]);

  const edit = useCallback(async (id: number, data: Partial<BusinessInvestment>) => {
    const res = await updateBusinessInvestment(id, data);
    await reload();
    return res.investment;
  }, [reload]);

  const remove = useCallback(async (id: number) => {
    await deleteBusinessInvestment(id);
    await reload();
  }, [reload]);

  return { investments, loading, reload, add, edit, remove };
}

export function useDashboardMetrics(period: string = "all") {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const data = await fetchDashboardMetrics(period);
      setMetrics(data);
    } catch { setMetrics(null); }
    finally { setLoading(false); }
  }, [period]);

  useEffect(() => { setLoading(true); reload(); }, [reload]);

  return { metrics, loading, reload };
}
