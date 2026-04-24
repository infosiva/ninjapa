import { getUser, updateProfile } from '../db.js';

export async function tool_set_profile(userId: number, args: Record<string, any>) {
  const merged = updateProfile(userId, args);
  return { success: true, profile: merged, message: 'Profile updated.' };
}

export async function tool_get_profile(userId: number) {
  const user = getUser(userId);
  const profile = JSON.parse(user?.profile ?? '{}');
  return {
    name: user?.first_name,
    username: user?.username,
    plan: user?.plan ?? 'free',
    profile,
  };
}

export async function tool_create_diet_plan(userId: number, args: {
  age?: number; weight_kg?: number; height_cm?: number;
  goal?: string; dietary_preference?: string;
}) {
  // Save profile details first
  const patch: Record<string, any> = {};
  if (args.age) patch.age = args.age;
  if (args.weight_kg) patch.weight_kg = args.weight_kg;
  if (args.height_cm) patch.height_cm = args.height_cm;
  if (args.goal) patch.fitness_goal = args.goal;
  if (args.dietary_preference) patch.dietary_preference = args.dietary_preference;
  if (Object.keys(patch).length > 0) updateProfile(userId, patch);

  // Signal to AI to generate the plan in its response
  return {
    success: true,
    user_details: args,
    action: 'generate_diet_plan',
    message: 'Profile saved. Now generating your personalised 7-day diet plan...',
  };
}

export async function tool_plan_trip(userId: number, args: {
  destination: string;
  duration_days: number;
  budget?: string;
  travel_style?: string;  // 'adventure' | 'relaxed' | 'cultural' | 'food'
  start_date?: string;
}) {
  // Signal to AI to generate travel plan in its response
  return {
    success: true,
    destination: args.destination,
    duration_days: args.duration_days,
    budget: args.budget,
    travel_style: args.travel_style ?? 'balanced',
    start_date: args.start_date,
    action: 'generate_travel_plan',
    message: `Planning your ${args.duration_days}-day trip to ${args.destination}...`,
  };
}
