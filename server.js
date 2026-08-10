const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!TMDB_API_KEY) {
  console.warn('WARNING: TMDB_API_KEY is not set.');
}

async function fetchFromTMDB(endpoint, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  url.searchParams.set('api_key', TMDB_API_KEY);

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`TMDB ${response.status}: ${await response.text()}`);
  }

  return response.json();
}

/* =========================
   SEARCH
========================= */

app.get('/api/search', async (req, res) => {
  try {
    const query = String(req.query.query || '').trim();
    const type = req.query.type || 'multi';

    if (!query) {
      return res.json({ results: [] });
    }

    const endpoint =
      type === 'person' ? '/search/person' : '/search/multi';

    const data = await fetchFromTMDB(endpoint, {
      query,
      include_adult: false
    });

    const results = (data.results || [])
      .filter(item =>
        type === 'person'
          ? item.media_type === 'person' || item.id
          : ['movie', 'tv'].includes(item.media_type)
      )
      .slice(0, 12);

    res.json({ results });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({
      error: 'Failed to search TMDB.'
    });
  }
});

/* =========================
   DETAILS
========================= */

app.get('/api/details/:type/:id', async (req, res) => {
  try {
    const mediaType =
      req.params.type === 'tv' ? 'tv' : 'movie';

    const data = await fetchFromTMDB(
      `/${mediaType}/${req.params.id}`,
      {
        append_to_response:
          'credits,watch/providers,keywords,release_dates'
      }
    );

    res.json(data);
  } catch (error) {
    console.error('Details error:', error.message);

    res.status(500).json({
      error: 'Failed to fetch details.'
    });
  }
});

/* =========================
   WATCH PROVIDERS
========================= */

app.get('/api/providers/:type/:id', async (req, res) => {
  try {
    const mediaType =
      req.params.type === 'tv' ? 'tv' : 'movie';

    const region = req.query.region || 'IN';

    const data = await fetchFromTMDB(
      `/${mediaType}/${req.params.id}/watch/providers`
    );

    res.json({
      region,
      providers: data.results?.[region] || null
    });
  } catch (error) {
    console.error('Providers error:', error.message);

    res.status(500).json({
      error: 'Failed to fetch watch providers.'
    });
  }
});

/* =========================================================
   RECOMMENDATION ENGINE

   PRIORITY:

   1. HASHTAGS
   2. FAVOURITE MOVIES
   3. YEAR RANGE
   4. LANGUAGE
   5. GENRE
   6. MOOD
   7. MINIMUM RATING

   IMPORTANT:
   - Mood is NOT a hard filter.
   - Rating is the weakest preference.
   - Already watched/recommended movies are excluded.
   - No random popular fallback.
   - Hashtags are matched against story/overview/keywords.
   - Kids-targeted movies are strongly avoided.
========================================================= */

app.post('/api/recommendations', async (req, res) => {
  try {
    const {
      mediaType = 'both',
      moods = [],
      genres = [],
      favoriteIds = [],
      languages = [],
      countries = [],
      language = 'any',
      country = 'any',
      rating = 0,
      minYear = 1900,
      maxYear = new Date().getFullYear(),
      hashtags = [],
      watchedIds = [],
      recommendedIds = []
    } = req.body;

    const currentYear = new Date().getFullYear();

    /* =========================
       NORMALIZE USER INPUT
    ========================= */

    const selectedMoods = Array.isArray(moods)
      ? moods
          .map(x => String(x).toLowerCase().trim())
          .filter(Boolean)
      : [];

    const selectedGenres = Array.isArray(genres)
      ? genres
          .map(Number)
          .filter(Number.isFinite)
      : [];

    const selectedLanguages =
      Array.isArray(languages) && languages.length
        ? languages
            .map(String)
            .map(x => x.toLowerCase())
        : language !== 'any'
          ? [String(language).toLowerCase()]
          : [];

    const selectedCountries =
      Array.isArray(countries) && countries.length
        ? countries
            .map(String)
            .map(x => x.toUpperCase())
        : country !== 'any'
          ? [String(country).toUpperCase()]
          : [];

    let fromYear = Number(minYear);
    let toYear = Number(maxYear);

    if (!Number.isFinite(fromYear)) {
      fromYear = 1900;
    }

    if (!Number.isFinite(toYear)) {
      toYear = currentYear;
    }

    fromYear = Math.max(
      1900,
      Math.min(fromYear, currentYear)
    );

    toYear = Math.max(
      1900,
      Math.min(toYear, currentYear)
    );

    if (fromYear > toYear) {
      [fromYear, toYear] = [toYear, fromYear];
    }

    const selectedTags = Array.isArray(hashtags)
      ? hashtags
          .map(tag =>
            String(tag)
              .replace(/^#/, '')
              .trim()
              .toLowerCase()
          )
          .filter(Boolean)
      : [];

    /* =========================
       EXCLUSION HISTORY
    ========================= */

    const excluded = new Set(
      [
        ...watchedIds,
        ...recommendedIds
      ].map(String)
    );

    const favoriteSet = new Set(
      favoriteIds.map(String)
    );

    /* =========================
       MOOD DEFINITIONS
    ========================= */

    const moodGenres = {
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
        10749
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
        'laugh',
        'comic'
      ],

      scary: [
        'horror',
        'haunted',
        'ghost',
        'monster',
        'terror',
        'demon',
        'survival'
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
        'corruption',
        'danger'
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
        'overcome',
        'achievement',
        'inspire',
        'struggle'
      ]
    };

    /* =========================
       TEXT HELPERS
    ========================= */

    const normalizeText = value =>
      String(value || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const movieText = movie =>
      normalizeText([
        movie.title,
        movie.name,
        movie.overview,
        ...(movie.keywords?.keywords || [])
          .map(k => k.name)
      ].join(' '));

    const movieGenres = movie =>
      (
        movie.genre_ids ||
        movie.genres?.map(g => g.id) ||
        []
      ).map(Number);

    const releaseYear = movie =>
      Number(
        String(
          movie.release_date ||
          movie.first_air_date ||
          ''
        ).slice(0, 4)
      );

    const movieKey = movie =>
      `${movie.media_type}-${movie.id}`;

    /* =========================
       FAVORITE PROFILE
    ========================= */

    const favoriteGenreFrequency =
      new Map();

    const favoriteKeywordFrequency =
      new Map();

    for (const favoriteId of favoriteIds) {
      try {
        const favorite =
          await fetchFromTMDB(
            `/movie/${favoriteId}`,
            {
              append_to_response:
                'keywords,credits,similar'
            }
          );

        for (
          const genre of
          favorite.genres || []
        ) {
          favoriteGenreFrequency.set(
            genre.id,
            (
              favoriteGenreFrequency.get(
                genre.id
              ) || 0
            ) + 1
          );
        }

        for (
          const keyword of
          favorite.keywords?.keywords || []
        ) {
          const word =
            normalizeText(keyword.name);

          if (word) {
            favoriteKeywordFrequency.set(
              word,
              (
                favoriteKeywordFrequency.get(
                  word
                ) || 0
              ) + 1
            );
          }
        }
      } catch {
        // Ignore unavailable favorites.
      }
    }

    const favoriteGenreMax =
      Math.max(
        1,
        ...favoriteGenreFrequency.values()
      );

    /* =========================
       CANDIDATE COLLECTION
    ========================= */

    const candidates = new Map();

    function addCandidates(
      results,
      type
    ) {
      for (const item of results || []) {
        const candidate = {
          ...item,
          media_type: type
        };

        const key =
          movieKey(candidate);

        if (
          !excluded.has(
            String(candidate.id)
          ) &&
          !excluded.has(key) &&
          !favoriteSet.has(
            String(candidate.id)
          )
        ) {
          candidates.set(
            key,
            candidate
          );
        }
      }
    }

    const types =
      mediaType === 'both'
        ? ['movie', 'tv']
        : [mediaType];

    /* =========================
       TMDB DISCOVER
    ========================= */

    for (const type of types) {
      const base = {
        sort_by: 'popularity.desc',
        include_adult: false,
        'vote_count.gte': 50
      };

      if (selectedGenres.length) {
        base.with_genres =
          selectedGenres.join('|');
      }

      if (
        selectedLanguages.length === 1
      ) {
        base.with_original_language =
          selectedLanguages[0];
      }

      if (
        selectedCountries.length === 1
      ) {
        base.with_origin_country =
          selectedCountries[0];
      }

      if (type === 'movie') {
        base['primary_release_date.gte'] =
          `${fromYear}-01-01`;

        base['primary_release_date.lte'] =
          `${toYear}-12-31`;
      } else {
        base['first_air_date.gte'] =
          `${fromYear}-01-01`;

        base['first_air_date.lte'] =
          `${toYear}-12-31`;
      }

      const requests = [];

      for (
        let page = 1;
        page <= 5;
        page++
      ) {
        requests.push(
          fetchFromTMDB(
            `/discover/${type}`,
            {
              ...base,
              page
            }
          )
        );
      }

      const results =
        await Promise.allSettled(
          requests
        );

      for (
        const result of results
      ) {
        if (
          result.status ===
          'fulfilled'
        ) {
          addCandidates(
            result.value.results,
            type
          );
        }
      }
    }

    /* =========================
       FAVORITE SIMILAR MOVIES
    ========================= */

    for (
      const favoriteId of favoriteIds
    ) {
      try {
        const similar =
          await fetchFromTMDB(
            `/movie/${favoriteId}/similar`,
            {
              page: 1
            }
          );

        addCandidates(
          similar.results,
          'movie'
        );
      } catch {
        // Ignore unavailable list.
      }
    }

    /* =========================
       DETAILS
    ========================= */

    const candidateArray =
      [...candidates.values()];

    const detailed = [];

    for (
      let start = 0;
      start < candidateArray.length;
      start += 20
    ) {
      const batch =
        candidateArray.slice(
          start,
          start + 20
        );

      const results =
        await Promise.allSettled(
          batch.map(item =>
            fetchFromTMDB(
              `/${item.media_type}/${item.id}`,
              {
                append_to_response:
                  'keywords,release_dates'
              }
            )
          )
        );

      results.forEach(
        (result, index) => {
          detailed.push(
            result.status ===
            'fulfilled'
              ? {
                  ...batch[index],
                  ...result.value
                }
              : batch[index]
          );
        }
      );

      if (
        detailed.length >= 250
      ) {
        break;
      }
    }

    /* =========================
       HARD FILTERS
    ========================= */

    const filtered =
      detailed.filter(movie => {
        const year =
          releaseYear(movie);

        /* YEAR RANGE */
        if (
          !Number.isFinite(year) ||
          year < fromYear ||
          year > toYear
        ) {
          return false;
        }

        /* LANGUAGE */
        if (
          selectedLanguages.length &&
          !selectedLanguages.includes(
            String(
              movie.original_language ||
              ''
            ).toLowerCase()
          )
        ) {
          return false;
        }

        /* COUNTRY */
        if (
          selectedCountries.length
        ) {
          const origins =
            movie.origin_country || [];

          if (
            !origins.some(code =>
              selectedCountries.includes(
                String(code).toUpperCase()
              )
            )
          ) {
            return false;
          }
        }

        return true;
      });

    /* =========================
       KIDS MOVIE DETECTION
    ========================= */

    const clearlyKidsMovie =
      movie => {
        const genres =
          new Set(
            movieGenres(movie)
          );

        const text =
          movieText(movie);

        const keywords =
          (
            movie.keywords?.keywords ||
            []
          ).map(k =>
            normalizeText(k.name)
          );

        const kidsWords = [
          'kids',
          'children',
          'child',
          'preschool',
          'young children',
          'family friendly',
          'family film',
          'educational'
        ];

        const kidsText =
          kidsWords.some(word =>
            text.includes(word)
          );

        const kidsKeyword =
          keywords.some(word =>
            kidsWords.some(k =>
              word.includes(k)
            )
          );

        const family =
          genres.has(10751);

        /*
          Family alone does NOT mean kids.
          Animation alone does NOT mean kids.
        */

        if (
          family &&
          (kidsText ||
            kidsKeyword)
        ) {
          return true;
        }

        return false;
      };

    const adultAudienceCandidates =
      filtered.filter(
        movie =>
          !clearlyKidsMovie(movie)
      );

    /* =========================
       HASHTAG MATCH
    ========================= */

    const tagMatchScore =
      (movie, tag) => {
        const text =
          movieText(movie);

        const words =
          normalizeText(tag)
            .split(' ')
            .filter(Boolean);

        if (!words.length) {
          return 0;
        }

        let matched = 0;

        for (
          const word of words
        ) {
          if (
            text.includes(word)
          ) {
            matched++;
          }
        }

        if (
          matched === words.length
        ) {
          return 1;
        }

        return (
          matched / words.length
        );
      };

    const hashtagScore =
      movie => {
        if (
          !selectedTags.length
        ) {
          return 0;
        }

        return (
          selectedTags.reduce(
            (sum, tag) =>
              sum +
              tagMatchScore(
                movie,
                tag
              ),
            0
          ) /
          selectedTags.length
        );
      };

    /* =========================
       FAVORITE SCORE
    ========================= */

    const favoriteScore =
      movie => {
        if (
          !favoriteGenreFrequency.size
        ) {
          return 0;
        }

        const genres =
          movieGenres(movie);

        let score = 0;

        for (
          const genre of genres
        ) {
          const frequency =
            favoriteGenreFrequency.get(
              genre
            );

          if (frequency) {
            score +=
              frequency /
              favoriteGenreMax;
          }
        }

        return Math.min(
          score / 2,
          1
        );
      };

    /* =========================
       LANGUAGE SCORE
    ========================= */

    const languageScore =
      movie => {
        if (
          !selectedLanguages.length
        ) {
          return 0.5;
        }

        return selectedLanguages.includes(
          String(
            movie.original_language ||
            ''
          ).toLowerCase()
        )
          ? 1
          : 0;
      };

    /* =========================
       GENRE SCORE
    ========================= */

    const genreScore =
      movie => {
        if (
          !selectedGenres.length
        ) {
          return 0.5;
        }

        const genres =
          movieGenres(movie);

        const matches =
          selectedGenres.filter(
            genre =>
              genres.includes(genre)
          ).length;

        return (
          matches /
          selectedGenres.length
        );
      };

    /* =========================
       MOOD SCORE
    ========================= */

    const moodScore =
      movie => {
        if (
          !selectedMoods.length
        ) {
          return 0.5;
        }

        const genres =
          movieGenres(movie);

        const text =
          movieText(movie);

        let matched = 0;

        for (
          const mood of selectedMoods
        ) {
          const genreMatch =
            (
              moodGenres[mood] ||
              []
            ).some(id =>
              genres.includes(id)
            );

          const wordMatch =
            (
              moodWords[mood] ||
              []
            ).some(word =>
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
          selectedMoods.length
        );
      };

    /* =========================
       RATING SCORE
    ========================= */

    const ratingScore =
      movie => {
        const value =
          Number(
            movie.vote_average || 0
          );

        if (!rating) {
          return Math.min(
            value / 10,
            1
          );
        }

        if (
          value >= Number(rating)
        ) {
          return Math.min(
            value / 10,
            1
          );
        }

        /*
          Rating is intentionally weak.
        */
        return Math.max(
          0,
          value / 10 - 0.15
        );
      };

    /* =========================
       HIT / POPULARITY
    ========================= */

    const hitScore =
      movie => {
        const ratingValue =
          Number(
            movie.vote_average || 0
          );

        const votes =
          Number(
            movie.vote_count || 0
          );

        const popularity =
          Number(
            movie.popularity || 0
          );

        let score = 0;

        if (
          ratingValue >= 7.5 &&
          votes >= 1000
        ) {
          score += 1;
        }

        score +=
          Math.min(
            popularity / 100,
            1
          ) * 0.5;

        return Math.min(
          score,
          1
        );
      };

    /* =========================
       FINAL PRIORITY RANKING
    ========================= */

    const scored =
      adultAudienceCandidates.map(
        movie => {
          const tag =
            hashtagScore(movie);

          const fav =
            favoriteScore(movie);

          const lang =
            languageScore(movie);

          const genre =
            genreScore(movie);

          const mood =
            moodScore(movie);

          const rate =
            ratingScore(movie);

          const hit =
            hitScore(movie);

          const year =
            releaseYear(movie);

          const yearScore =
            Number.isFinite(year)
              ? 1
              : 0;

          /*
            Lexicographic priority.

            Higher priority categories are compared FIRST.
            A lower priority category cannot overpower
            a higher priority category.
          */

          const priorityVector = [
            Math.round(tag * 1000),
            Math.round(fav * 1000),
            Math.round(yearScore * 1000),
            Math.round(lang * 1000),
            Math.round(genre * 1000),
            Math.round(mood * 1000),
            Math.round(rate * 1000),
            Math.round(hit * 1000)
          ];

          const reasons = [];

          if (tag > 0) {
            reasons.push(
              'Matches your story hashtags'
            );
          }

          if (fav > 0) {
            reasons.push(
              'Similar to your favorite movies'
            );
          }

          if (lang === 1) {
            reasons.push(
              'Matches your language'
            );
          }

          if (
            genre > 0 &&
            genre !== 0.5
          ) {
            reasons.push(
              'Matches your genre'
            );
          }

          if (
            mood > 0 &&
            mood !== 0.5
          ) {
            reasons.push(
              'Fits your mood'
            );
          }

          if (
            Number(
              movie.vote_average || 0
            ) >= 7.5 &&
            Number(
              movie.vote_count || 0
            ) >= 1000
          ) {
            reasons.push(
              'Popular hit'
            );
          }

          return {
            ...movie,

            _priorityVector:
              priorityVector,

            _hitScore:
              hit,

            matchReason:
              reasons
                .slice(0, 3)
                .join(' • ') ||
              'Matches your selected preferences'
          };
        }
      );

    /* =========================
       SORT
    ========================= */

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

        /* Hit movies as tie-breaker */
        if (
          b._hitScore !==
          a._hitScore
        ) {
          return (
            b._hitScore -
            a._hitScore
          );
        }

        /* Rating as final tie-breaker */
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

    /* =========================
       RETURN TOP 12
    ========================= */

    const recommendations =
      scored
        .slice(0, 12)
        .map(movie => {
          const clean = {
            ...movie
          };

          delete clean._priorityVector;
          delete clean._hitScore;

          return clean;
        });

    res.json({
      total:
        recommendations.length,

      recommendations
    });

  } catch (error) {
    console.error(
      'Recommendation error:',
      error
    );

    res.status(500).json({
      error:
        'Failed to generate recommendations.'
    });
  }
});

/* =========================
   START SERVER
========================= */

app.listen(PORT, () => {
  console.log(
    `YourChoice running on port ${PORT}`
  );
});
