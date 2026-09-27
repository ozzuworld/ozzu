// Preview stub of lib/business-hooks — LIVE data via the bridge proxy
// (serve.py forwards /business/* to 127.0.0.1:3333), so the WORK screen and the
// venture detail sheet render with the real ventures, not fixtures.
import { useEffect, useState, useCallback } from "react";
import { apiFetch } from "./bridge-api.js";

export function useBusiness() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    try {
      setError(null);
      const data = await apiFetch("/business/projects");
      setProjects(Array.isArray(data) ? data : data.projects || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { projects, loading, error, reload };
}

export function useBusinessProject(id) {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    if (id == null) { setLoading(false); return; }
    try {
      const d = await apiFetch(`/business/projects/${id}`);
      setProject(d.project || d);
    } catch {} finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  return {
    project,
    loading,
    reload,
    editTask: async () => {},
    uploadAttachment: async () => {},
    removeAttachment: async () => {},
    addExpense: async () => {},
    editExpense: async () => {},
    removeExpense: async () => {},
  };
}

export function useProjectFinancials(_id) {
  return { financials: null, loading: false, reload: async () => {} };
}

export function useDashboardMetrics(_period) {
  const [metrics, setMetrics] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const d = await apiFetch("/business/dashboard?period=" + (_period || "month"));
        if (mounted) setMetrics(d.metrics || d);
      } catch {} finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [_period]);
  return { metrics, loading };
}

export default useBusiness;

export function useContacts() {
  const [contacts, setContacts] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    (async () => {
      try { const d = await apiFetch("/business/contacts"); if (mounted) setContacts(Array.isArray(d) ? d : d.contacts || []); } catch {} finally { if (mounted) setLoading(false); }
    })();
    return () => { mounted = false; };
  }, []);
  return { contacts, loading, reload: async () => {} };
}

export function useShipments() {
  return { shipments: [], invoices: [], investments: [], loading: false, reload: async () => {} };
}
