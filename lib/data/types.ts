export type CarrierProfile = {
  mc_number: string | null;
  dot_number: string | null;
  company_name: string;
  primary_contact: string | null;
  email: string | null;
  phone: string | null;
  address?: string | null;
  equipment_types: string[];
  preferred_lanes: string[];
  home_base_zip: string | null;
  factoring_company: string | null;
  payment_terms_preference: string | null;
  reliability_score: number | null;
  loads_completed_with_goodlane: number | null;
  avg_response_time_hours: number | null;
  insurance_expiry: string | null;
  authority_status: string | null;
  safety_rating: string | null;
  notes: string | null;
  onboarded: boolean;
};

export type CarrierEmail = {
  email_id: string;
  timestamp: string;
  from_name: string;
  from_email: string;
  to_email: string;
  subject: string;
  body: string;
  mc_number: string | null;
  load_reference: string | null;
  equipment_mentioned: string | null;
  rate_quoted_usd: number | null;
  intent: string | null;
};

export type Load = {
  load_id: string;
  origin_city: string;
  origin_state: string;
  origin_zip: string;
  destination_city: string;
  destination_state: string;
  destination_zip: string;
  distance_miles: number;
  equipment_type: string;
  weight_lbs: number | null;
  pickup_date: string;
  pickup_window: string | null;
  delivery_date: string;
  offered_rate_usd: number;
  status: "open" | "covered" | "delivered" | "cancelled";
  shipper_name: string | null;
  internal_notes: string | null;
};

export type RateHistoryRow = {
  week_start: string;
  origin_state: string;
  destination_state: string;
  equipment_type: string;
  avg_rate_per_mile: number;
  min_rate_per_mile: number;
  max_rate_per_mile: number;
  load_volume: number;
};

export type TranscriptSegment = {
  speaker: string;
  text: string;
  start: number;
  end: number;
};

/** Structured fields extracted offline from a diarized call transcript. */
export type CallExtraction = {
  carrier_speaker: string | null;
  mc_number: string | null;
  company_name: string | null;
  load_reference: string | null;
  origin_state: string | null;
  destination_state: string | null;
  carrier_rate_usd: number | null;
  dispatcher_rate_usd: number | null;
  equipment: string | null;
  available_location: string | null;
  available_date: string | null;
  questions: string[];
};

export type CallTranscript = {
  call_id: string;
  type: string;
  file: string;
  transcript: string;
  segments: TranscriptSegment[];
  speakers: string[];
  /** Structured fields from the call-side extraction pipeline (optional). */
  extracted?: CallExtraction | null;
  /** Warnings raised during extraction (e.g. multiple_rates, mc_corrected). */
  extraction_warnings?: string[];
  /** Synthetic ordering timestamp for timeline queries (ISO 8601). */
  recorded_at: string;
};

export type TimelineEvent =
  | { kind: "email"; timestamp: string; data: CarrierEmail }
  | { kind: "call"; timestamp: string; data: CallTranscript };
