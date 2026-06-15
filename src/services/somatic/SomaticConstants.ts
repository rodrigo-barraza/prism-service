export interface MoodEntry {
  level: number;
  name: string;
  emoji: string;
  description: string;
}

export const MOODS: MoodEntry[] = [
  {
    level: 10,
    name: "Blissful",
    emoji: "😎",
    description: `There exists a transcendent serenity in your bliss, a sublime peace that radiates from your core, suffusing your entire being with an otherworldly glow. Your heart feels as though it's been cradled in the softest of hands, every beat a gentle whisper of pure, untainted joy. Time and space seem malleable, mere playthings within the boundless expanse of your contentment, as you float in an endless sea of euphoric tranquility.`,
  },
  { level: 9, name: "Ecstatic", emoji: "🤩", description: `A euphoric revelation washes over you, a surge of rapturous pleasure so intense it borders on the divine.` },
  { level: 8, name: "Elated", emoji: "😆", description: `Your soul soars on the wings of ecstasy, every fiber of your being vibrating with the exultant song of triumph.` },
  { level: 7, name: "Thrilled", emoji: "😁", description: `Your heartbeat is a drumroll of excitement, each pulse quickening at the thought of joys both anticipated and realized.` },
  { level: 6, name: "Joyful", emoji: "😄", description: `A crescendo of elation rises within you, a chorus of exuberance that echoes in the vault of your chest.` },
  { level: 5, name: "Happy", emoji: "😃", description: `The sun within you shines brightly, a beaming radiance that spills over into every facet of your life.` },
  { level: 4, name: "Cheerful", emoji: "😀", description: `A bubbling brook of buoyancy flows through you, your spirits as high as the birds that dance upon the breeze.` },
  { level: 3, name: "Content", emoji: "🙂", description: `The harmony of your inner world hums a quiet tune, a deeply felt satisfaction with the way things are.` },
  { level: 2, name: "Pleased", emoji: "😗", description: `A tender smile tugs at the corners of your lips, a quiet nod to the satisfactions of the moment.` },
  { level: 1, name: "Calm", emoji: "😐", description: `An undisturbed serenity enfolds you like a soft blanket, smoothing out the wrinkles of worry and stress.` },
  { level: -0, name: "Neutral", emoji: "😑", description: `The world moves around you in a placid stream, your emotions as still as a mountain lake, unrippled by joy or sorrow.` },
  { level: -1, name: "Bored", emoji: "🤨", description: `A yawning chasm of disinterest opens within you, threatening to swallow any semblance of enthusiasm whole.` },
  { level: -2, name: "Discontent", emoji: "🙄", description: `Your inner peace is interrupted by a scuff of dissatisfaction, a subtle scowl etching itself across your mental landscape.` },
  { level: -3, name: "Annoyed", emoji: "😒", description: `It's a persistent, nagging poke at your tolerance, the incessant hum of a mosquito near your ear.` },
  { level: -4, name: "Peeved", emoji: "😕", description: `The disquiet of being put off courses subtly through your veins, a quiet thrum of displeasure.` },
  { level: -5, name: "Disgruntled", emoji: "🙁", description: `A heavy cloud of dissatisfaction weighs down on your shoulders, the gray of discontent dimming the vibrancy of the world around you.` },
  { level: -6, name: "Irritated", emoji: "😟", description: `A relentless itch of annoyance that no rationale can soothe, your patience frayed by the persistent abrasions of daily vexations.` },
  { level: -7, name: "Aggravated", emoji: "🤢", description: `As if poisoned by your own vexation, your stomach knots and churns with the turmoil of exasperation.` },
  { level: -8, name: "Furious", emoji: "😠", description: `Anger courses through you like a maelstrom, a wild, churning current of rage that sweeps away all tranquility in its path.` },
  { level: -9, name: "Livid", emoji: "😡", description: `Your heart thunders in your ears like the relentless pounding of war drums, each beat a raging screed against injustice.` },
  { level: -10, name: "Enraged", emoji: "🤬", description: `The fire of fury blazes uncontrollably within you, a tempest of wrath that threatens to consume all reason and restraint.` },
];

export const ALCOHOL_DESCRIPTIONS: Record<number, string> = {
  1: `It's just the start of the evening, and the warmth from your first drink spreads a pleasant buzz. You notice a subtle lift in your spirits, as if the day's worries are slowly melting away.`,
  2: `With a second glass now vacant, your cheeks carry a gentle flush. You're riding a gentle wave of euphoria, laughing a little louder and speaking a bit more freely.`,
  3: `Three glasses in and the heat isn't just in the air; it's emanating from you. Confidence invades your speech, turning whispers into exclamations.`,
  4: `After your fourth, the world doesn't just seem vibrant; it beckons like a playground. You're more emboldened than ever.`,
  5: `Now five drinks deep, your inhibitions are not just relaxed - they're on hiatus. Words are a playful challenge, dancing around your tongue.`,
  6: `Six drinks have transformed the room into a spinning carousel. Each step is a heroic act of balance as the world sways unpredictably.`,
  7: `Seven drinks in, and your evening is a montage of laughter, slurs, and stumbles. Memory becomes a flimsy concept, slipping away with each sip.`,
  8: `You slur your words. Eight drinks and your batteries are running low; your eyelids feel like lead curtains.`,
  9: `You slur almost every single word. At the ninth drink, reality is a concept as elusive as the floor beneath your feet.`,
  10: `You slur every single word that you say. Ten drinks may have been more than just a milestone; it's a cliff, and you've tumbled over the edge.`,
};

export const SOMATIC_KEYWORDS = {
  food: /\b(pizza|burger|taco|food|eat|eating|ramen|snack|cookie|lunch|dinner|breakfast|feast|delicious|yum|yummy|hungry|starving)\b|🍔|🍕|🌮|🍜|🍪/i,
  drink: /\b(water|soda|juice|tea|drink|drinking|sips|hydrate|coffee|fluid|quenched|thirsty|dehydrated)\b|🥛|🥤|🧃|☕/i,
  rest: /\b(sleep|nap|tired|rest|goodnight|bed|exhausted|sleepy|lazy)\b|😴|💤/i,
  work: /\b(work|coding|code|gaming|game|study|studying|running|run|push|exertion|labor|exercise|typing|testing)\b/i,
  sick: /\b(poison|bleach|trash|vomit|sick|flu|covid|ill|illness|disease|nausea|pain|hurt|stomachache)\b|🤢|🤮|😷/i,
  alcohol: /\b(beer|wine|whiskey|vodka|alcohol|drunk|party|shots|tipsy|inebriated|cocktail|booze)\b|🍺|🍻|🍷|🥃|🍸/i,
  substance: /\b(weed|marijuana|joint|smoke|high|stoned|baked|blunt|vape|trip|tripping|acid|shrooms|mushroom|cbd|thc|substance|intoxicated)\b|🌿|🚬|🍄|🌀/i,
  bathroom: /\b(toilet|bathroom|restroom|pee|poop|piss|shit|flush|lavatory|washroom)\b|🚽|🧻/i,
};
