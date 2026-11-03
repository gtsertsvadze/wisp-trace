// The fixed task taxonomy. Every public label (feed rows, trends, recipe titles) comes from here,
// never from free text in a trace — that is what keeps public pages anonymised and injection-free.
// Ids are a stable contract (stored in D1). Keywords may be extended freely.

export interface TaskType {
  id: string;
  label: string;    // public feed label, past tense: 'Booked a restaurant'
  trend: string;    // trend group label; several types may share one: 'Returns & refunds'
  kind: string;     // coarse kind shown under feed rows: 'Bookings'
  recipe: string;   // recipe title, imperative: 'Book a table'
  slug: string;     // URL slug of the recipe title
  keywords: RegExp[];
}

const t = (
  id: string, label: string, trend: string, kind: string, recipe: string, keywords: RegExp[],
): TaskType => ({ id, label, trend, kind, recipe, slug: slugify(recipe), keywords });

export function slugify(s: string): string {
  return s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export const TASK_TYPES: TaskType[] = [
  t('restaurant_booking', 'Booked a restaurant', 'Restaurant bookings', 'Bookings', 'Book a table',
    [/\b(restaurant|table for|dinner reservation|reserve a table|book(ed)? a table|brunch|opentable|resy)\b/i]),
  t('booking_change', 'Changed a booking', 'Booking changes', 'Bookings', 'Change a booking time',
    [/\b(change|move|reschedul\w*|modify)\b.{0,30}\b(booking|reservation|appointment)\b/i]),
  t('appointment_booking', 'Booked an appointment', 'Appointment booking', 'Bookings', 'Book an appointment',
    [/\b(dentist|doctor|gp|clinic|vet|haircut|barber|salon|physio|appointment)\b/i]),
  t('home_service', 'Found a tradesperson', 'Home services', 'Home', 'Book a home service',
    [/\b(plumber|electrician|cleaner|handyman|locksmith|roofer|painter|movers?|tradesperson)\b/i]),
  t('event_tickets', 'Bought event tickets', 'Event tickets', 'Shopping', 'Buy event tickets',
    [/\b(tickets?|concert|gig|theatre|theater|festival|match|show)\b/i]),
  t('membership_cancellation', 'Cancelled a membership', 'Subscription cancellations', 'Cancellations', 'Cancel a membership',
    [/\b(cancel\w*|terminate|end)\b.{0,30}\b(membership|gym|club)\b/i, /\bgym\b.{0,20}\bcancel/i]),
  t('membership_pause', 'Paused a membership', 'Subscription cancellations', 'Cancellations', 'Pause a membership',
    [/\b(pause|freeze|suspend)\b.{0,30}\b(membership|gym|subscription)\b/i]),
  t('subscription_cancellation', 'Cancelled a subscription', 'Subscription cancellations', 'Cancellations', 'Cancel a subscription',
    [/\b(cancel\w*|unsubscribe|stop)\b.{0,30}\b(subscription|plan|streaming|trial|newsletter|account)\b/i]),
  t('subscription_change', 'Changed a subscription plan', 'Plan changes', 'Admin', 'Change a plan',
    [/\b(upgrade|downgrade|switch|move)\b.{0,30}\b(plan|tier|annual|monthly|subscription)\b/i]),
  t('gift_shopping', 'Bought a gift', 'Gift shopping', 'Shopping', 'Buy a gift',
    [/\b(gift|present|birthday|anniversary|christmas|secret santa|stocking)\b/i]),
  t('grocery_order', 'Ordered groceries', 'Grocery orders', 'Shopping', 'Order groceries',
    [/\b(grocer\w*|supermarket|weekly shop|food shop)\b/i]),
  t('food_delivery', 'Ordered food delivery', 'Food delivery', 'Shopping', 'Order food delivery',
    [/\b(takeaway|takeout|food delivery|deliveroo|uber ?eats|doordash|order (a )?pizza)\b/i]),
  t('product_purchase', 'Bought something online', 'Online shopping', 'Shopping', 'Buy a product',
    [/\b(buy|purchase|order)\b/i]),
  t('price_comparison', 'Compared prices', 'Price comparison', 'Research', 'Compare prices',
    [/\b(compare|cheapest|best price|price check|deal)\b/i]),
  t('order_tracking', 'Tracked an order', 'Order tracking', 'Shopping', 'Track an order',
    [/\b(track\w*|where is)\b.{0,30}\b(order|parcel|package|delivery)\b/i]),
  t('return_item', 'Returned a parcel', 'Returns & refunds', 'Returns', 'Return an item',
    [/\b(return\w*)\b.{0,30}\b(item|parcel|order|package|purchase)\b/i, /\breturn label\b/i]),
  t('refund_request', 'Requested a refund', 'Returns & refunds', 'Returns', 'Request a refund',
    [/\b(refund|chargeback|money back|reimburse\w*)\b/i]),
  t('flight_search', 'Compared flight prices', 'Flight search', 'Travel', 'Find a flight',
    [/\b(flight|fly|airfare)\b.{0,30}\b(price|compare|find|search|cheap)\b/i, /\b(compare|find|search)\b.{0,30}\bflights?\b/i]),
  t('flight_booking', 'Booked a flight', 'Flight bookings', 'Travel', 'Book a flight',
    [/\bbook\w*\b.{0,30}\bflights?\b/i]),
  t('flight_change', 'Changed a flight', 'Travel changes', 'Travel', 'Change a flight date',
    [/\b(change|move|reschedul\w*|rebook)\b.{0,30}\bflights?\b/i]),
  t('flight_checkin', 'Checked in for a flight', 'Travel admin', 'Travel', 'Check in online',
    [/\b(check[- ]?in|boarding pass)\b/i]),
  t('hotel_booking', 'Booked a hotel', 'Hotel bookings', 'Travel', 'Book a hotel',
    [/\bbook\w*\b.{0,30}\b(hotel|room|airbnb|stay|accommodation)\b/i]),
  t('hotel_change', 'Changed a hotel booking', 'Travel changes', 'Travel', 'Change a hotel booking',
    [/\b(change|modify|move|extend|cancel)\b.{0,30}\b(hotel|room|stay)\b/i]),
  t('ride_booking', 'Booked a ride', 'Rides', 'Travel', 'Book a ride',
    [/\b(taxi|cab|uber|lyft|ride to|airport transfer)\b/i]),
  t('expense_report', 'Filed an expense report', 'Expense filing', 'Admin', 'File an expense report',
    [/\b(expense\w*|receipts?|reimbursement claim)\b/i]),
  t('bill_payment', 'Paid a bill', 'Bills', 'Finance', 'Pay a bill',
    [/\b(pay|settle)\b.{0,30}\b(bill|invoice|utility)\b/i]),
  t('parking_fine', 'Paid a parking fine', 'Fines & fees', 'Admin', 'Pay a parking fine',
    [/\b(parking|penalty|fine|ticket)\b.{0,20}\b(fine|charge|notice|pay)\b/i, /\bpcn\b/i]),
  t('insurance_renewal', 'Renewed car insurance', 'Insurance', 'Finance', 'Renew insurance',
    [/\b(renew\w*)\b.{0,30}\b(insurance|policy|cover)\b/i]),
  t('insurance_quote', 'Got an insurance quote', 'Insurance', 'Finance', 'Get an insurance quote',
    [/\b(insurance|cover)\b.{0,30}\b(quote|compare)\b/i, /\bquote\b.{0,30}\binsurance\b/i]),
  t('utility_switch', 'Switched a provider', 'Provider switching', 'Home', 'Switch provider',
    [/\b(switch|change)\b.{0,30}\b(energy|electricity|gas|broadband|internet|mobile|phone) (provider|plan|supplier|tariff)\b/i]),
  t('account_update', 'Updated account details', 'Account admin', 'Admin', 'Update account details',
    [/\b(update|change)\b.{0,30}\b(address|details|email|phone number|payment method)\b/i]),
  t('account_recovery', 'Recovered an account', 'Account admin', 'Admin', 'Recover an account',
    [/\b(reset|recover|forgot)\b.{0,30}\b(password|account|login)\b/i]),
  t('form_filling', 'Filled in a form', 'Forms & applications', 'Admin', 'Fill in a form',
    [/\b(form|application|apply for|register for|sign up for)\b/i]),
  t('government_service', 'Used a government service', 'Government services', 'Admin', 'Complete a government service',
    [/\b(passport|visa|licen[cs]e|council|tax return|dmv|hmrc|irs|benefits)\b/i]),
  t('customer_support', 'Contacted customer support', 'Customer support', 'Admin', 'Contact support',
    [/\b(customer (support|service)|complain\w*|support ticket|live chat)\b/i]),
  t('document_summary', 'Summarised a document', 'Research & summaries', 'Research', 'Summarise a document',
    [/\b(summari[sz]\w*|tl;?dr|digest)\b/i, /\b(pdf|report|paper|document)\b.{0,20}\b(read|review)\b/i]),
  t('research', 'Researched a topic', 'Research & summaries', 'Research', 'Research a topic',
    [/\b(research|find out|look up|investigate|what is the best)\b/i]),
  t('inbox_triage', 'Sorted an inbox', 'Inbox & messages', 'Work', 'Triage an inbox',
    [/\b(inbox|emails?|triage|reply to|draft a reply)\b/i]),
  t('scheduling', 'Scheduled a meeting', 'Scheduling', 'Work', 'Schedule a meeting',
    [/\b(schedule|calendar|meeting|invite)\b/i]),
  t('job_application', 'Applied for a job', 'Job applications', 'Work', 'Apply for a job',
    [/\b(job|cv|resume|cover letter|vacanc\w*)\b/i]),
  t('rental_search', 'Searched for a rental', 'Housing', 'Home', 'Find a rental',
    [/\b(rent(al)?|apartment|flat|lease|letting)\b/i]),
  t('code_change', 'Shipped a code change', 'Coding', 'Work', 'Make a code change',
    [/\b(bug|fix|refactor|pull request|pr|deploy|repo|code|test suite)\b/i]),
  t('other', 'Did a web task', 'Other tasks', 'Other', 'Complete a task', []),
];

const BY_ID = new Map(TASK_TYPES.map(x => [x.id, x]));
const BY_SLUG = new Map(TASK_TYPES.map(x => [x.slug, x]));

export const OTHER = BY_ID.get('other')!;

export function taskType(id: string | null | undefined): TaskType {
  return (id && BY_ID.get(id)) || OTHER;
}

export function taskTypeBySlug(slug: string): TaskType | undefined {
  return BY_SLUG.get(slug);
}

export function isTaskTypeId(id: unknown): id is string {
  return typeof id === 'string' && BY_ID.has(id);
}

/** Distinct trend labels, in taxonomy order. */
export const TREND_GROUPS: string[] = [...new Set(TASK_TYPES.map(x => x.trend))];

/** Task type ids belonging to a trend label. */
export function typesInTrend(trend: string): string[] {
  return TASK_TYPES.filter(x => x.trend === trend).map(x => x.id);
}
