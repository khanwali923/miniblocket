import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

let sb;
try {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    console.log("Supabase initierad:", !!sb);
} catch(e) {
    console.error("Supabase init failed:", e);
    alert("Kunde inte ansluta till databasen.");
}

export { sb };

/*något saknas */