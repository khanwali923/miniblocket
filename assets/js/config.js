// === PRODUKTION ===
const SUPABASE_URL_PROD = 'https://txhfogiljfejwdmvmkng.supabase.co';
const SUPABASE_ANON_KEY_PROD = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR4aGZvZ2lsamZlandkbXZta25nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk5NjgwNjcsImV4cCI6MjA4NTU0NDA2N30.009lF-xi1a0B9SQZDAJw10Bez29-wiptzZD11E73gDE';

// === STAGING ===
const SUPABASE_URL_STAGING = 'https://qcszxirgrysyzfmdwatu.supabase.co';
const SUPABASE_ANON_KEY_STAGING = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjc3p4aXJncnlzeXpmbWR3YXR1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAwNTQ1MjEsImV4cCI6MjA4NTYzMDUyMX0.Tl87mzHg3U7BoaTi4s5TILenFzUz9QOqu7X7yxd7dt4';

// staging & prod
// Välj miljö
const ENV = 'staging'; // ändra till 'prod' vid lansering

const SUPABASE_URL = ENV === 'prod' ? SUPABASE_URL_PROD : SUPABASE_URL_STAGING;
const SUPABASE_ANON_KEY = ENV === 'prod' ? SUPABASE_ANON_KEY_PROD : SUPABASE_ANON_KEY_STAGING;

const CONFIG = {
    appName: 'Miniblocket',
    version: '1.0',
    defaultImage: "https://placehold.co/600x400?text=Ingen+bild"
};

export { SUPABASE_URL, SUPABASE_ANON_KEY, ENV, CONFIG };