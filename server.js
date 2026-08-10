import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* =========================================================
   SETTINGS
========================================================= */

const ABSOLUTE_MIN_YEAR = 2000;
const CURRENT_YEAR = new Date().getFullYear();

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 10;

/* =========================================================
   TMDB REQUEST
========================================================= */

async function fetchFromTMDB(endpoint, params = {}) {

  if (
    !TMDB_API_KEY ||
    TMDB_API_KEY === 'YOUR_TMDB_API_KEY_HERE'
  ) {
    throw new Error(
      'TMDB API Key is not configured in .env'
    );
  }

  const queryParams = new URLSearchParams({
    api_key: TMDB_API_KEY,
    ...params
  });

  const url =
    `${TMDB_BASE_URL}${endpoint}?${queryParams.toString()}`;

  if (cache.has(url)) {

    const {
      timestamp,
      data
    } = cache.get(url);

    if (
      Date.now() - timestamp <
      CACHE_TTL
    ) {
      return data;
    }
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `TMDB HTTP error! Status: ${response.status}`
    );
  }

  const data = await response.json();

  cache.set(
    url,
    {
      timestamp: Date.now(),
      data
    }
  );

  return data;
}

/* =========================================================
   HELPERS
========================================================= */

function normalizeText(value) {

  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function getReleaseYear(item) {

  const date =
    item.release_date ||
    item.first_air_date ||
    '';

  const year =
    parseInt(
      String(date).substring(0, 4),
      10
    );

  return Number.isFinite(year)
    ? year
    : null;
}


function isValidYear(item) {

  const year =
    getReleaseYear(item);

  return (
    year !== null &&
    year >= ABSOLUTE_MIN_YEAR &&
    year <= CURRENT_YEAR
  );
}


function movieKey(item) {

  return `${item.media_type || 'movie'}-${item.id}`;
}


/* =========================================================
   HASHTAG THEME DICTIONARY

   Hashtags are about STORY / SUBJECT.
   NOT actors.
   NOT directors.
   NOT production houses.
========================================================= */

const themeDictionary = {

  superhero: [
    'superhero',
    'super hero',
    'superpowered',
    'super power',
    'superpowers',
    'superhuman',
    'metahuman',
    'masked hero',
    'comic book hero',
    'vigilante'
  ],

  entrepreneurship: [
    'entrepreneur',
    'entrepreneurship',
    'entrepreneurial',
    'businessman',
    'businesswoman',
    'business',
    'startup',
    'founder',
    'company',
    'corporation',
    'business empire',
    'business owner'
  ],

  commonman: [
    'common man',
    'common person',
    'ordinary man',
    'ordinary person',
    'ordinary people',
    'everyman',
    'ordinary citizen',
    'working class',
    'middle class'
  ],

  fighter: [
    'fighter',
    'warrior',
    'combat',
    'martial arts',
    'boxing',
    'wrestling',
    'fighter pilot',
    'soldier'
  ],

  gangster: [
    'gangster',
    'gangsters',
    'mobster',
    'mobsters',
    'mafia',
    'mob',
    'organized crime',
    'crime family',
    'underworld',
    'cartel',
    'criminal organization'
  ],

  detective: [
    'detective',
    'private investigator',
    'investigator',
    'investigation',
    'mystery',
    'detective story'
  ],

  spy: [
    'spy',
    'spies',
    'espionage',
    'secret agent',
    'undercover agent',
    'intelligence agency'
  ],

  heist: [
    'heist',
    'robbery',
    'bank robbery',
    'robbers',
    'thieves',
    'thief',
    'burglary'
  ],

  revenge: [
    'revenge',
    'vengeance',
    'revenge mission',
    'avenging',
    'avenge'
  ],

  survival: [
    'survival',
    'survive',
    'survivor',
    'stranded',
    'trapped',
    'wilderness'
  ],

  friendship: [
    'friendship',
    'friends',
    'best friends',
    'friend'
  ],

  family: [
    'family',
    'parents',
    'father',
    'mother',
    'brother',
    'sister',
    'siblings'
  ],

  school: [
    'school',
    'student',
    'students',
    'classroom',
    'teacher',
    'high school'
  ],

  college: [
    'college',
    'university',
    'student life',
    'campus'
  ],

  crime: [
    'crime',
    'criminal',
    'murder',
    'killer',
    'police',
    'criminal investigation'
  ],

  war: [
    'war',
    'soldier',
    'army',
    'battle',
    'military',
    'warfare'
  ],

  space: [
    'space',
    'astronaut',
    'spaceship',
    'planet',
    'galaxy',
    'space mission'
  ]
};


function getThemeTerms(tag) {

  const clean =
    normalizeText(tag)
      .replace(/\s+/g, '');

  if (
    themeDictionary[clean]
  ) {
    return themeDictionary[clean];
  }

  return [
    normalizeText(tag)
  ].filter(Boolean);
}


/* =========================================================
   MOOD
========================================================= */

const moodGenreMap = {

  funny: [35],

  scary: [27],

  romantic: [10749],

  exciting: [
    28,
    12,
    53
  ],

  dark: [
    80,
    9648,
    53,
    27
  ],

  emotional: [
    18,
    10749
  ],

  'thought-provoking': [
    878,
    9648,
    18,
    99
  ],

  'feel-good': [
    35,
    18,
    10751
  ],

  suspenseful: [
    53,
    9648,
    80
  ],

  adventurous: [
    12,
    28,
    14,
    878
  ],

  inspiring: [
    18,
    36,
    99
  ]
};


const moodWords = {

  funny: [
    'funny',
    'comedy',
    'humor',
    'hilarious',
    'laugh'
  ],

  scary: [
    'horror',
    'haunted',
    'ghost',
    'monster',
    'terror',
    'demon'
  ],

  romantic: [
    'love',
    'romance',
    'romantic',
    'relationship',
    'couple'
  ],

  exciting: [
    'action',
    'mission',
    'battle',
    'fight',
    'chase',
    'escape',
    'adventure'
  ],

  dark: [
    'dark',
    'crime',
    'murder',
    'killer',
    'revenge',
    'corruption'
  ],

  emotional: [
    'emotional',
    'family',
    'loss',
    'grief',
    'struggle',
    'love'
  ],

  'thought-provoking': [
    'truth',
    'identity',
    'science',
    'future',
    'society',
    'humanity',
    'philosophy'
  ],

  'feel-good': [
    'hope',
    'friendship',
    'dream',
    'joy',
    'success',
    'family'
  ],

  suspenseful: [
    'mystery',
    'detective',
    'investigation',
    'secret',
    'crime',
    'killer',
    'thriller'
  ],

  adventurous: [
    'adventure',
    'journey',
    'quest',
    'explore',
    'expedition',
    'survival'
  ],

  inspiring: [
    'dream',
    'ambition',
    'success',
    'achievement',
    'inspire',
    'struggle',
    'overcome'
  ]
};


/* =========================================================
   MOVIE TEXT

   Hashtags are matched against:
   - title
   - overview
   - tagline
   - TMDB keywords

   NOT actors/directors/production companies.
========================================================= */

function getMovieText(item) {

  const keywordText =
    (
      item.keywords?.keywords ||
      []
    )
      .map(k => k.name)
      .join(' ');

  return normalizeText(
    [
      item.title,
      item.name,
      item.overview,
      item.tagline,
      keywordText
    ].join(' ')
  );
}


/* =========================================================
   HASHTAG SCORE
========================================================= */

function getHashtagScore(
  item,
  hashtags
) {

  if (
    !hashtags.length
  ) {
    return 0;
  }

  const text =
    getMovieText(item);

  let total = 0;

  for (
    const rawTag of hashtags
  ) {

    const tag =
      String(rawTag)
        .replace(/^#/, '')
        .trim()
        .toLowerCase();

    const terms =
      getThemeTerms(tag);

    let matched = false;

    for (
      const term of terms
    ) {

      const normalizedTerm =
        normalizeText(term);

      if (
        normalizedTerm &&
        text.includes(normalizedTerm)
      ) {

        matched = true;
        break;
      }
    }

    /*
      For custom hashtags:
      #entrepreneurship
      #superhero
      etc.
    */

    if (
      !matched &&
      !themeDictionary[tag]
    ) {

      const words =
        normalizeText(tag)
          .split(' ')
          .filter(Boolean);

      if (
        words.length
      ) {

        const wordMatches =
          words.filter(
            word =>
              text.includes(word)
          );

        if (
          wordMatches.length ===
          words.length
        ) {
          matched = true;
        }
      }
    }

    if (matched) {
      total++;
    }
  }

  return (
    total /
    hashtags.length
  );
}


/* =========================================================
   FAVORITE PROFILE
========================================================= */

async function buildFavoriteProfile(
  favoriteIds
) {

  const profile = {

    genres: new Map(),

    keywords: new Map(),

    texts: []
  };


  for (
    const id of favoriteIds
  ) {

    try {

      const movie =
        await fetchFromTMDB(
          `/movie/${id}`,
          {
            append_to_response:
              'keywords'
          }
        );


      for (
        const genre
        of movie.genres || []
      ) {

        profile.genres.set(
          genre.id,

          (
            profile.genres.get(
              genre.id
            ) || 0
          ) + 1
        );
      }


      for (
        const keyword
        of movie.keywords?.keywords ||
        []
      ) {

        const key =
          normalizeText(
            keyword.name
          );

        if (key) {

          profile.keywords.set(
            key,

            (
              profile.keywords.get(
                key
              ) || 0
            ) + 1
          );
        }
      }


      profile.texts.push(
        getMovieText(movie)
      );

    } catch {
      // Ignore invalid favorites.
    }
  }

  return profile;
}


/* =========================================================
   FAVORITE SCORE
========================================================= */

function getFavoriteScore(
  item,
  profile
) {

  let score = 0;

  const itemGenres =
    item.genre_ids ||
    (
      item.genres || []
    ).map(g => g.id);


  if (
    profile.genres.size &&
    itemGenres.length
  ) {

    for (
      const genre of itemGenres
    ) {

      if (
        profile.genres.has(
          genre
        )
      ) {

        score +=
          profile.genres.get(
            genre
          );
      }
    }
  }


  /*
    Keyword similarity.
  */

  const text =
    getMovieText(item);


  for (
    const keyword
    of profile.keywords.keys()
  ) {

    if (
      text.includes(keyword)
    ) {

      score +=
        profile.keywords.get(
          keyword
        ) * 1.5;
    }
  }


  const maxGenre =
    Math.max(
      1,
      ...profile.genres.values()
    );


  return Math.min(
    score /
      (
        maxGenre * 4 +
        1
      ),
    1
  );
}


/* =========================================================
   TIMELINE SCORE

   NEWER MOVIES HAVE HIGHER PRIORITY.
========================================================= */

function getTimelineScore(
  item,
  minYear,
  maxYear
) {

  const year =
    getReleaseYear(item);

  if (
    year === null
  ) {
    return 0;
  }


  if (
    maxYear <= minYear
  ) {
    return 1;
  }


  return Math.max(
    0,
    Math.min(
      1,
      (
        year - minYear
      ) /
      (
        maxYear - minYear
      )
    )
  );
}


/* =========================================================
   LANGUAGE
========================================================= */

function getLanguageScore(
  item,
  languages
) {

  if (
    !languages.length
  ) {
    return 0.5;
  }

  const original =
    String(
      item.original_language ||
      ''
    ).toLowerCase();

  return languages.includes(
    original
  )
    ? 1
    : 0;
}


/* =========================================================
   COUNTRY
========================================================= */

function getCountryScore(
  item,
  countries
) {

  if (
    !countries.length
  ) {
    return 0.5;
  }

  const origins =
    (
      item.origin_country ||
      []
    ).map(
      c =>
        String(c).toUpperCase()
    );

  return origins.some(
    c =>
      countries.includes(c)
  )
    ? 1
    : 0;
}


/* =========================================================
   GENRE
========================================================= */

function getGenreScore(
  item,
  genres
) {

  if (
    !genres.length
  ) {
    return 0.5;
  }

  const itemGenres =
    item.genre_ids ||
    (
      item.genres || []
    ).map(g => g.id);


  const matches =
    genres.filter(
      g =>
        itemGenres.includes(
          Number(g)
        )
    ).length;


  return (
    matches /
    genres.length
  );
}


/* =========================================================
   MOOD
========================================================= */

function getMoodScore(
  item,
  moods
) {

  if (
    !moods.length
  ) {
    return 0.5;
  }


  const itemGenres =
    item.genre_ids ||
    (
      item.genres || []
    ).map(g => g.id);


  const text =
    getMovieText(item);


  let matched = 0;


  for (
    const rawMood of moods
  ) {

    const mood =
      String(
        rawMood
      ).toLowerCase();


    const genreMatch =
      (
        moodGenreMap[mood] ||
        []
      ).some(
        id =>
          itemGenres.includes(id)
      );


    const wordMatch =
      (
        moodWords[mood] ||
        []
      ).some(
        word =>
          text.includes(word)
      );


    if (
      genreMatch ||
      wordMatch
    ) {
      matched++;
    }
  }


  return (
    matched /
    moods.length
  );
}


/* =========================================================
   HIT / BLOCKBUSTER SCORE
========================================================= */

function getHitScore(item) {

  const rating =
    Number(
      item.vote_average || 0
    );

  const votes =
    Number(
      item.vote_count || 0
    );

  const popularity =
    Number(
      item.popularity || 0
    );


  let score = 0;


  if (
    rating >= 8 &&
    votes >= 5000
  ) {

    score = 1;

  } else if (
    rating >= 7.5 &&
    votes >= 2500
  ) {

    score = 0.9;

  } else if (
    rating >= 7.2 &&
    votes >= 1500
  ) {

    score = 0.8;

  } else if (
    rating >= 7 &&
    votes >= 750
  ) {

    score = 0.65;

  } else if (
    rating >= 6.5 &&
    votes >= 300
  ) {

    score = 0.45;
  }


  if (
    popularity >= 100
  ) {

    score =
      Math.min(
        1,
        score + 0.2
      );

  } else if (
    popularity >= 60
  ) {

    score =
      Math.min(
        1,
        score + 0.1
      );
  }


  return score;
}


/* =========================================================
   KIDS MOVIE FILTER

   Prevents the recommender from filling results
   with children's content.
========================================================= */

function isClearlyKidsMovie(item) {

  const genres =
    item.genre_ids ||
    (
      item.genres || []
    ).map(g => g.id);

  const text =
    getMovieText(item);


  const keywords =
    (
      item.keywords?.keywords ||
      []
    ).map(
      k =>
        normalizeText(k.name)
    );


  const kidsTerms = [
    'kids',
    'children',
    'child',
    'preschool',
    'educational',
    'children film',
    'children movie',
    'kids movie',
    'kids film',
    'nursery'
  ];


  const kidsText =
    kidsTerms.some(
      term =>
        text.includes(term)
    );


  const kidsKeyword =
    keywords.some(
      keyword =>
        kidsTerms.some(
          term =>
            keyword.includes(term)
        )
    );


  /*
    Only block when there is strong evidence
    that the movie is specifically children's content.
  */

  return (
    genres.includes(10751) &&
    (
      kidsText ||
      kidsKeyword
    )
  );
}


/* =========================================================
   SEARCH
========================================================= */

app.get(
  '/api/search',
  async (req, res) => {

    try {

      const {
        query,
        type = 'multi'
      } = req.query;


      if (
        !query ||
        query.trim().length < 2
      ) {

        return res.json({
          results: []
        });
      }


      const endpoint =
        type === 'person'
          ? '/search/person'
          : '/search/multi';


      const data =
        await fetchFromTMDB(
          endpoint,
          {
            query,
            include_adult: false
          }
        );


      const results =
        (
          data.results || []
        )
          .filter(item =>
            type === 'person'
              ? true
              : (
                  item.media_type ===
                    'movie' ||
                  item.media_type ===
                    'tv'
                )
          )
          .slice(0, 8);


      res.json({
        results
      });

    } catch (error) {

      console.error(
        'Search error:',
        error.message
      );

      res.status(500).json({
        error:
          'Failed to search TMDB.'
      });
    }
  }
);


/* =========================================================
   DETAILS
========================================================= */

app.get(
  '/api/details/:type/:id',
  async (req, res) => {

    try {

      const {
        type,
        id
      } = req.params;


      const mediaType =
        type === 'tv'
          ? 'tv'
          : 'movie';


      const data =
        await fetchFromTMDB(
          `/${mediaType}/${id}`,
          {
            append_to_response:
              'credits,watch/providers,keywords'
          }
        );


      res.json(data);

    } catch (error) {

      console.error(
        'Details error:',
        error.message
      );

      res.status(500).json({
        error:
          'Failed to fetch details.'
      });
    }
  }
);


/* =========================================================
   WATCH PROVIDERS
========================================================= */

app.get(
  '/api/providers/:type/:id',
  async (req, res) => {

    try {

      const {
        type,
        id
      } = req.params;


      const region =
        req.query.region ||
        'IN';


      const mediaType =
        type === 'tv'
          ? 'tv'
          : 'movie';


      const data =
        await fetchFromTMDB(
          `/${mediaType}/${id}/watch/providers`
        );


      const regionData =
        data.results
          ? (
              data.results[region] ||
              null
            )
          : null;


      res.json({
        region,
        providers:
          regionData
      });

    } catch (error) {

      console.error(
        'Providers error:',
        error.message
      );

      res.status(500).json({
        error:
          'Failed to fetch watch providers.'
      });
    }
  }
);


/* =========================================================
   RECOMMENDATIONS
========================================================= */

app.post(
  '/api/recommendations',
  async (req, res) => {

    try {

      const {

        mediaType = 'movie',

        moods = [],

        genres = [],

        favoriteIds = [],

        languages = [],

        countries = [],

        language = 'any',

        country = 'any',

        rating = 0,

        minYear = 2000,

        maxYear = CURRENT_YEAR,

        hashtags = [],

        watchedIds = [],

        recommendedIds = []

      } = req.body;


      /* ===================================================
         NORMALIZE FILTERS
      =================================================== */

      const selectedMoods =
        Array.isArray(moods)
          ? moods
              .map(x =>
                String(x)
                  .toLowerCase()
                  .trim()
              )
              .filter(Boolean)
          : [];


      const selectedGenres =
        Array.isArray(genres)
          ? genres
              .map(Number)
              .filter(
                Number.isFinite
              )
          : [];


      const selectedLanguages =
        Array.isArray(languages) &&
        languages.length
          ? languages
              .map(x =>
                String(x)
                  .toLowerCase()
                  .trim()
              )
          : (
              language !== 'any'
                ? [
                    String(language)
                      .toLowerCase()
                  ]
                : []
            );


      const selectedCountries =
        Array.isArray(countries) &&
        countries.length
          ? countries
              .map(x =>
                String(x)
                  .toUpperCase()
                  .trim()
              )
          : (
              country !== 'any'
                ? [
                    String(country)
                      .toUpperCase()
                  ]
                : []
            );


      const selectedHashtags =
        Array.isArray(hashtags)
          ? hashtags
              .map(x =>
                String(x)
                  .replace(/^#/, '')
                  .trim()
                  .toLowerCase()
              )
              .filter(Boolean)
          : [];


      /*
        HARD YEAR LIMIT

        Even if frontend sends 1980,
        server changes it to 2000.
      */

      let startYear =
        Number(minYear);

      let endYear =
        Number(maxYear);


      if (
        !Number.isFinite(
          startYear
        )
      ) {
        startYear = 2000;
      }


      if (
        !Number.isFinite(
          endYear
        )
      ) {
        endYear =
          CURRENT_YEAR;
      }


      startYear =
        Math.max(
          ABSOLUTE_MIN_YEAR,
          Math.min(
            startYear,
            CURRENT_YEAR
          )
        );


      endYear =
        Math.max(
          ABSOLUTE_MIN_YEAR,
          Math.min(
            endYear,
            CURRENT_YEAR
          )
        );


      if (
        startYear > endYear
      ) {

        [
          startYear,
          endYear
        ] = [
          endYear,
          startYear
        ];
      }


      /* ===================================================
         EXCLUSIONS

         watched + previous recommendations + favorites
      =================================================== */

      const excludeSet =
        new Set([
          ...(
            Array.isArray(
              watchedIds
            )
              ? watchedIds
              : []
          ),
          ...(
            Array.isArray(
              recommendedIds
            )
              ? recommendedIds
              : []
          ),
          ...(
            Array.isArray(
              favoriteIds
            )
              ? favoriteIds
              : []
          )
        ].map(String));


      /* ===================================================
         FAVORITE PROFILE
      =================================================== */

      const favoriteProfile =
        await buildFavoriteProfile(
          Array.isArray(
            favoriteIds
          )
            ? favoriteIds
            : []
        );


      /* ===================================================
         TYPES
      =================================================== */

      const typesToFetch =
        mediaType === 'both'
          ? ['movie', 'tv']
          : (
              mediaType === 'tv'
                ? ['tv']
                : ['movie']
            );


      let candidatePool = [];


      /* ===================================================
         DISCOVER

         IMPORTANT:
         Date filtering happens AT TMDB level.
      =================================================== */

      for (
        const type
        of typesToFetch
      ) {

        const discoverParams = {

          sort_by:
            'popularity.desc',

          include_adult:
            false,

          'vote_count.gte':
            100,

          page: 1
        };


        if (
          selectedGenres.length
        ) {

          discoverParams.with_genres =
            selectedGenres.join('|');
        }


        if (
          selectedLanguages.length ===
          1
        ) {

          discoverParams.with_original_language =
            selectedLanguages[0];
        }


        if (
          selectedCountries.length ===
          1
        ) {

          discoverParams.with_origin_country =
            selectedCountries[0];
        }


        if (
          Number(rating) > 0
        ) {

          discoverParams[
            'vote_average.gte'
          ] =
            Number(rating);
        }


        /*
          HARD TIMELINE.
        */

        if (
          type === 'movie'
        ) {

          discoverParams[
            'primary_release_date.gte'
          ] =
            `${startYear}-01-01`;

          discoverParams[
            'primary_release_date.lte'
          ] =
            `${endYear}-12-31`;

        } else {

          discoverParams[
            'first_air_date.gte'
          ] =
            `${startYear}-01-01`;

          discoverParams[
            'first_air_date.lte'
          ] =
            `${endYear}-12-31`;
        }


        /*
          Fetch several pages.
        */

        for (
          let page = 1;
          page <= 5;
          page++
        ) {

          try {

            const data =
              await fetchFromTMDB(
                `/discover/${type}`,
                {
                  ...discoverParams,
                  page
                }
              );


            if (
              data.results
            ) {

              candidatePool.push(
                ...data.results.map(
                  item => ({
                    ...item,
                    media_type:
                      type
                  })
                )
              );
            }

          } catch (error) {

            console.error(
              `Discover ${type} page ${page}:`,
              error.message
            );
          }
        }
      }


      /* ===================================================
         FAVORITE SIMILAR MOVIES

         These are STILL subjected to 2000+ filtering.
      =================================================== */

      for (
        const favoriteId
        of (
          Array.isArray(
            favoriteIds
          )
            ? favoriteIds
            : []
        )
      ) {

        try {

          const similar =
            await fetchFromTMDB(
              `/movie/${favoriteId}/similar`,
              {
                page: 1
              }
            );


          for (
            const item
            of (
              similar.results ||
              []
            )
          ) {

            const movie = {
              ...item,
              media_type:
                'movie'
            };


            /*
              ABSOLUTE OLD-MOVIE BLOCK.
            */

            if (
              !isValidYear(movie)
            ) {
              continue;
            }


            const year =
              getReleaseYear(movie);


            if (
              year < startYear ||
              year > endYear
            ) {
              continue;
            }


            candidatePool.push(
              movie
            );
          }

        } catch {
          // Ignore invalid favorites.
        }
      }


      /* ===================================================
         POPULAR FALLBACK

         Still HARD FILTERED to selected timeline.
      =================================================== */

      if (
        candidatePool.length < 30
      ) {

        for (
          const type
          of typesToFetch
        ) {

          try {

            const popData =
              await fetchFromTMDB(
                `/${type}/popular`,
                {
                  page: 1
                }
              );


            for (
              const item
              of (
                popData.results ||
                []
              )
            ) {

              const movie = {
                ...item,
                media_type:
                  type
              };


              /*
                NEVER allow old movies.
              */

              if (
                !isValidYear(movie)
              ) {
                continue;
              }


              const year =
                getReleaseYear(
                  movie
                );


              if (
                year < startYear ||
                year > endYear
              ) {
                continue;
              }


              candidatePool.push(
                movie
              );
            }

          } catch {
            // Ignore fallback errors.
          }
        }
      }


      /* ===================================================
         DEDUPLICATE + HARD FILTER
      =================================================== */

      const uniqueMap =
        new Map();


      for (
        const item
        of candidatePool
      ) {

        /*
          ABSOLUTE SAFETY FILTER.
        */

        if (
          !isValidYear(item)
        ) {
          continue;
        }


        const year =
          getReleaseYear(item);


        if (
          year < startYear ||
          year > endYear
        ) {
          continue;
        }


        const key =
          movieKey(item);


        if (
          excludeSet.has(
            String(item.id)
          )
        ) {
          continue;
        }


        if (
          excludeSet.has(key)
        ) {
          continue;
        }


        if (
          uniqueMap.has(key)
        ) {
          continue;
        }


        uniqueMap.set(
          key,
          item
        );
      }


      let candidates =
        Array.from(
          uniqueMap.values()
        );


      /* ===================================================
         GET FULL DETAILS

         Required because hashtags need overview,
         tagline and keywords.
      =================================================== */

      const detailed = [];


      for (
        let i = 0;
        i < candidates.length;
        i += 20
      ) {

        const batch =
          candidates.slice(
            i,
            i + 20
          );


        const results =
          await Promise.allSettled(

            batch.map(item =>
              fetchFromTMDB(
                `/${item.media_type}/${item.id}`,
                {
                  append_to_response:
                    'keywords'
                }
              )
            )
          );


        results.forEach(
          (
            result,
            index
          ) => {

            if (
              result.status ===
              'fulfilled'
            ) {

              detailed.push({
                ...batch[index],
                ...result.value
              });

            } else {

              detailed.push(
                batch[index]
              );
            }
          }
        );
      }


      /* ===================================================
         HARD FILTER AGAIN AFTER DETAILS
      =================================================== */

      candidates =
        detailed.filter(
          item => {

            const year =
              getReleaseYear(item);


            /*
              ABSOLUTE RULE:
              NO MOVIE BEFORE 2000.
            */

            if (
              year === null ||
              year < 2000
            ) {
              return false;
            }


            /*
              TIMELINE SLIDER.
            */

            if (
              year < startYear ||
              year > endYear
            ) {
              return false;
            }


            /*
              LANGUAGE.
            */

            if (
              selectedLanguages.length &&
              !selectedLanguages.includes(
                String(
                  item.original_language ||
                  ''
                ).toLowerCase()
              )
            ) {

              return false;
            }


            /*
              COUNTRY.
            */

            if (
              selectedCountries.length
            ) {

              const origins =
                (
                  item.origin_country ||
                  []
                ).map(
                  x =>
                    String(
                      x
                    ).toUpperCase()
                );


              if (
                !origins.some(
                  c =>
                    selectedCountries.includes(
                      c
                    )
                )
              ) {

                return false;
              }
            }


            /*
              Minimum rating.
            */

            if (
              Number(rating) > 0 &&
              Number(
                item.vote_average || 0
              ) < Number(rating)
            ) {

              return false;
            }


            /*
              Kids filter.
            */

            if (
              isClearlyKidsMovie(
                item
              )
            ) {

              return false;
            }


            return true;
          }
        );


      /* ===================================================
         HASHTAG HARD PRIORITY
      =================================================== */

      if (
        selectedHashtags.length
      ) {

        const hashtagMatches =
          candidates.filter(
            item =>
              getHashtagScore(
                item,
                selectedHashtags
              ) >= 0.5
          );


        /*
          If enough exact theme matches exist,
          reject everything else.

          Example:
          #superhero
          =>
          superhero-related movies only.
        */

        if (
          hashtagMatches.length >= 5
        ) {

          candidates =
            hashtagMatches;
        }
      }


      /* ===================================================
         SCORE
         
         PRIORITY:

         1. Hashtags
         2. Favorites
         3. Timeline / newer movies
         4. Language
         5. Genre
         6. Mood
         7. Rating

         Hit status is used strongly for
         TOP FIVE.
      =================================================== */

      const scored =
        candidates.map(
          item => {

            const hashtagScore =
              getHashtagScore(
                item,
                selectedHashtags
              );


            const favoriteScore =
              getFavoriteScore(
                item,
                favoriteProfile
              );


            const timelineScore =
              getTimelineScore(
                item,
                startYear,
                endYear
              );


            const languageScore =
              getLanguageScore(
                item,
                selectedLanguages
              );


            const countryScore =
              getCountryScore(
                item,
                selectedCountries
              );


            const genreScore =
              getGenreScore(
                item,
                selectedGenres
              );


            const moodScore =
              getMoodScore(
                item,
                selectedMoods
              );


            const ratingScore =
              Math.min(
                1,
                Number(
                  item.vote_average || 0
                ) / 10
              );


            const hitScore =
              getHitScore(item);


            /*
              Lexicographic priority.

              A stronger hashtag match must beat
              a weaker hashtag match before other
              factors matter.
            */

            const priorityVector = [

              Math.round(
                hashtagScore *
                100000
              ),

              Math.round(
                favoriteScore *
                10000
              ),

              Math.round(
                timelineScore *
                10000
              ),

              Math.round(
                languageScore *
                10000
              ),

              Math.round(
                genreScore *
                10000
              ),

              Math.round(
                moodScore *
                10000
              ),

              Math.round(
                ratingScore *
                10000
              ),

              Math.round(
                hitScore *
                10000
              )
            ];


            return {

              ...item,

              _hashtagScore:
                hashtagScore,

              _favoriteScore:
                favoriteScore,

              _timelineScore:
                timelineScore,

              _languageScore:
                languageScore,

              _countryScore:
                countryScore,

              _genreScore:
                genreScore,

              _moodScore:
                moodScore,

              _ratingScore:
                ratingScore,

              _hitScore:
                hitScore,

              _priorityVector:
                priorityVector
            };
          }
        );


      /* ===================================================
         NORMAL SORT
      =================================================== */

      scored.sort(
        (a, b) => {

          for (
            let i = 0;
            i <
            a._priorityVector.length;
            i++
          ) {

            if (
              a._priorityVector[i] !==
              b._priorityVector[i]
            ) {

              return (
                b._priorityVector[i] -
                a._priorityVector[i]
              );
            }
          }


          return (
            Number(
              b.vote_average || 0
            ) -
            Number(
              a.vote_average || 0
            )
          );
        }
      );


      /* ===================================================
         TOP FIVE

         Must preferably be:
         - correct hashtag/theme
         - similar to favorites
         - hit/superhit/blockbuster
         - newer
      =================================================== */

      const topFivePool =
        scored.filter(
          item => {

            /*
              If hashtag exists,
              top 5 must match it.
            */

            if (
              selectedHashtags.length &&
              item._hashtagScore < 0.5
            ) {

              return false;
            }


            /*
              Strong hit requirement.
            */

            if (
              item._hitScore < 0.45
            ) {

              return false;
            }


            return true;
          }
        );


      topFivePool.sort(
        (a, b) => {

          /*
            Hashtag first.
          */

          if (
            b._hashtagScore !==
            a._hashtagScore
          ) {

            return (
              b._hashtagScore -
              a._hashtagScore
            );
          }


          /*
            Favorite similarity.
          */

          if (
            b._favoriteScore !==
            a._favoriteScore
          ) {

            return (
              b._favoriteScore -
              a._favoriteScore
            );
          }


          /*
            Newer movie.
          */

          if (
            b._timelineScore !==
            a._timelineScore
          ) {

            return (
              b._timelineScore -
              a._timelineScore
            );
          }


          /*
            Hit strength.
          */

          return (
            b._hitScore -
            a._hitScore
          );
        }
      );


      const topFive =
        topFivePool.slice(
          0,
          5
        );


      const topFiveKeys =
        new Set(
          topFive.map(
            movie =>
              movieKey(movie)
          )
        );


      /* ===================================================
         REMAINING RECOMMENDATIONS
      =================================================== */

      const remaining =
        scored.filter(
          item =>
            !topFiveKeys.has(
              movieKey(item)
            )
        );


      const finalResults = [
        ...topFive,
        ...remaining
      ].slice(
        0,
        12
      );


      /* ===================================================
         MATCH REASONS
      =================================================== */

      const recommendations =
        finalResults.map(
          item => {

            const reasons = [];


            if (
              item._hashtagScore >=
              0.5
            ) {

              reasons.push(
                'Matches your hashtags'
              );
            }


            if (
              item._favoriteScore >=
              0.25
            ) {

              reasons.push(
                'Similar to your favorite movies'
              );
            }


            if (
              item._timelineScore >=
              0.65
            ) {

              reasons.push(
                'Newer within your timeline'
              );
            }


            if (
              item._languageScore ===
              1
            ) {

              reasons.push(
                'Matches your language'
              );
            }


            if (
              item._genreScore >
                0 &&
              item._genreScore !==
                0.5
            ) {

              reasons.push(
                'Matches your genre'
              );
            }


            if (
              item._moodScore >
                0 &&
              item._moodScore !==
                0.5
            ) {

              reasons.push(
                'Fits your mood'
              );
            }


            if (
              item._hitScore >=
              0.75
            ) {

              reasons.push(
                'Superhit / blockbuster'
              );
            }


            const clean = {
              ...item,

              matchReason:
                reasons
                  .slice(0, 3)
                  .join(' • ') ||
                'Matches your preferences'
            };


            delete clean._hashtagScore;
            delete clean._favoriteScore;
            delete clean._timelineScore;
            delete clean._languageScore;
            delete clean._countryScore;
            delete clean._genreScore;
            delete clean._moodScore;
            delete clean._ratingScore;
            delete clean._hitScore;
            delete clean._priorityVector;


            return clean;
          }
        );


      res.json({

        total:
          recommendations.length,

        recommendations,

        appliedFilters: {

          minYear:
            startYear,

          maxYear:
            endYear,

          minimumAllowedYear:
            2000,

          hashtags:
            selectedHashtags,

          languages:
            selectedLanguages,

          countries:
            selectedCountries,

          genres:
            selectedGenres,

          moods:
            selectedMoods,

          minimumRating:
            Number(rating) || 0
        }
      });

    } catch (error) {

      console.error(
        'Recommendation Error:',
        error
      );

      res.status(500).json({

        error:
          'Failed to generate recommendations.'
      });
    }
  }
);


/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {

    console.log(
      '==================================================='
    );

    console.log(
      `YourChoice Web App running on port ${PORT}`
    );

    console.log(
      `Absolute minimum movie year: ${ABSOLUTE_MIN_YEAR}`
    );

    console.log(
      '==================================================='
    );
  }
);
