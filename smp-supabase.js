/* smp-supabase.js
 * Shared Supabase client + helpers for SchoolMasterPro.
 * Load order: supabase.min.js -> smp-supabase.js -> page inline script.
 * Does NOT call any Supabase method at top level. Exposes a global SMP object.
 */
(function () {
  const SUPABASE_URL = "https://wpumtrgiffajjynoqaiw.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwdW10cmdpZmZhamp5bm9xYWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4Nzc3OTQsImV4cCI6MjA5MzQ1Mzc5NH0.Iw1QdxnujWPekNavhes7ThWBLY8GjxdWD29fTNE5L98";

  let _client = null;

  function getClient() {
    if (!_client) {
      if (!window.supabase || !window.supabase.createClient) {
        throw new Error(
          "Supabase library not loaded. Ensure supabase.min.js loads before smp-supabase.js."
        );
      }
      _client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
    return _client;
  }

  async function getSession() {
    try {
      const { data, error } = await getClient().auth.getSession();
      if (error) {
        console.error("getSession error:", error.message);
        return null;
      }
      return data.session;
    } catch (err) {
      console.error("getSession exception:", err.message);
      return null;
    }
  }

  async function signUp(email, password) {
    try {
      const { data, error } = await getClient().auth.signUp({ email, password });
      if (error) return { user: null, session: null, error };
      return { user: data.user, session: data.session, error: null };
    } catch (err) {
      return { user: null, session: null, error: { message: err.message } };
    }
  }

  async function signIn(email, password) {
    try {
      const { data, error } = await getClient().auth.signInWithPassword({
        email,
        password,
      });
      if (error) return { session: null, user: null, error };
      return { session: data.session, user: data.user, error: null };
    } catch (err) {
      return { session: null, user: null, error: { message: err.message } };
    }
  }

  async function signOut() {
    try {
      const { error } = await getClient().auth.signOut();
      return { error };
    } catch (err) {
      return { error: { message: err.message } };
    }
  }

  async function provisionSchool(params) {
    try {
      const { data, error } = await getClient().rpc("provision_school", params);
      return { data, error };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  async function getMyOperatorAndSchool(userId) {
    try {
      const { data, error } = await getClient()
        .from("operators")
        .select(
          "id, full_name, school_id, is_active, schools:school_id(id, name, plan, status, school_code, trial_expires_at)"
        )
        .eq("id", userId)
        .maybeSingle();
      return { data, error };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  window.SMP = {
    getClient,
    getSession,
    signUp,
    signIn,
    signOut,
    provisionSchool,
    getMyOperatorAndSchool,
  };
})();
