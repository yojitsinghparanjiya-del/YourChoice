const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const TMDB_API_KEY = process.env.TMDB_API_KEY;

async function fetchFromTMDB(endpoint, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${endpoint}`);
  url.searchParams.set('api_key', TMDB_API_KEY);

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, value);
    }
  });

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`TMDB error ${response.status}`);
  }

  return response.json();
}

// Core Recommendation Engine
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

    const selectedLanguages = languages.length
      ? languages.map(String)
      : (language !== 'any' ? [String(language)] : []);

    const selectedCountries = countries.length
      ? countries.map(String)
      : (country !== 'any' ? [String(country)] : []);

    let lowerYear = Number(minYear) || 1900;
    let upperYear = Number(maxYear) || new Date().getFullYear();

    if (lowerYear > upperYear) {
      [lowerYear, upperYear] = [upperYear, lowerYear];
    }

    const selectedGenres = genres
      .map(Number)
      .filter(Number.isFinite);

    const selectedMoods = moods
      .map(m => String(m).toLowerCase().trim())
      .filter(Boolean);

    const selectedTags = hashtags
      .map(t => String(t).replace(/^#/, '').trim().toLowerCase())
      .filter(Boolean);

    // Movies already watched or already recommended are excluded.
    const excludedIds = new Set([
      ...watchedIds.map(String),
      ...recommendedIds.map(String),
      ...favoriteIds.map(String)
    ]);

    // ---------------------------------------------------------
    // FAVORITE MOVIE ANALYSIS
    // ---------------------------------------------------------

    const favoriteGenreFrequency = new Map();
    const favoriteKeywords = new Set();

    for (const favoriteId of favoriteIds) {
      try {
        const favorite = await fetchFromTMDB(`/movie/${favoriteId}`, {
          append_to_response: 'keywords'
        });

        (favorite.genres || []).forEach(genre => {
          favoriteGenreFrequency.set(
            genre.id,
            (favoriteGenreFrequency.get(genre.id) || 0) + 1
          );
        });

        (favorite.keywords?.keywords || []).forEach(keyword => {
          favoriteKeywords.add(
            String(keyword.name).toLowerCase()
          );
        });
      } catch {
        // Ignore invalid favorite IDs.
      }
    }

    // ---------------------------------------------------------
    // MOOD DEFINITIONS
    // ---------------------------------------------------------

    const moodGenreMap = {
      funny: [35],
      scary: [27],
      romantic: [10749],
      exciting: [28, 12, 53],
      dark: [80, 9648, 53, 27],
      emotional: [18, 10749],
      'thought-provoking': [878, 99, 18, 9648],
      'feel-good': [35, 10751, 10749],
      relaxing: [35, 10751, 16, 10402],
      suspenseful: [53, 9648, 80],
      adventurous: [12, 28, 14, 878],
      inspiring: [18, 36, 99, 10751]
    };

    const moodWords = {
      funny: [
        'funny',
        'humor',
        'comedy',
        'hilarious',
        'comic',
        'laugh'
      ],

      scary: [
        'horror',
        'haunted',
        'ghost',
        'monster',
        'terror',
        'survive'
      ],

      romantic: [
        'romance',
        'romantic',
        'love',
        'relationship',
        'couple'
      ],

      exciting: [
        'action',
        'adventure',
        'mission',
        'battle',
        'chase',
        'fight',
        'escape'
      ],

      dark: [
        'dark',
        'crime',
        'murder',
        'killer',
        'corruption',
        'revenge',
        'danger'
      ],

      emotional: [
        'emotional',
        'family',
        'loss',
        'grief',
        'love',
        'struggle'
      ],

      'thought-provoking': [
        'truth',
        'identity',
        'science',
        'future',
        'society',
        'humanity',
        'mystery'
      ],

      'feel-good': [
        'friendship',
        'family',
        'happy',
        'hope',
        'joy',
        'comedy',
        'dream'
      ],

      relaxing: [
        'family',
        'friendship',
        'journey',
        'music',
        'nature',
        'comedy'
      ],

      suspenseful: [
        'mystery',
        'investigation',
        'detective',
        'crime',
        'secret',
        'killer',
        'thriller'
      ],

      adventurous: [
        'adventure',
        'journey',
        'explore',
        'quest',
        'expedition',
        'survival'
      ],

      inspiring: [
        'dream',
        'ambition',
        'success',
        'overcome',
        'struggle',
        'inspire',
        'achievement'
      ]
    };

    // ---------------------------------------------------------
    // GET MOVIE / TV POOL
    // ---------------------------------------------------------

    const types =
      mediaType === 'both'
        ? ['movie', 'tv']
        : [mediaType];

    const pool = [];

    for (const type of types) {
      const params = {
        sort_by: 'popularity.desc',
        'vote_count.gte': 50
      };

      if (selectedGenres.length) {
        params.with_genres = selectedGenres.join('|');
      }

      if (selectedLanguages.length === 1) {
        params.with_original_language =
          selectedLanguages[0];
      }

      if (selectedCountries.length) {
        params.with_origin_country =
          selectedCountries.join('|');
      }

      if (type === 'movie') {
        params['primary_release_date.gte'] =
          `${lowerYear}-01-01`;

        params['primary_release_date.lte'] =
          `${upperYear}-12-31`;
      } else {
        params['first_air_date.gte'] =
          `${lowerYear}-01-01`;

        params['first_air_date.lte'] =
          `${upperYear}-12-31`;
      }

      const pages = await Promise.allSettled([
        fetchFromTMDB(`/discover/${type}`, {
          ...params,
          page: 1
        }),

        fetchFromTMDB(`/discover/${type}`, {
          ...params,
          page: 2
        }),

        fetchFromTMDB(`/discover/${type}`, {
          ...params,
          page: 3
        })
      ]);

      pages.forEach(result => {
        if (
          result.status === 'fulfilled' &&
          result.value?.results
        ) {
          pool.push(
            ...result.value.results.map(movie => ({
              ...movie,
              media_type: type
            }))
          );
        }
      });
    }

    // ---------------------------------------------------------
    // FAVORITE-SIMILAR MOVIES
    // ---------------------------------------------------------

    for (const favoriteId of favoriteIds) {
      try {
        const similar = await fetchFromTMDB(
          `/movie/${favoriteId}/similar`,
          { page: 1 }
        );

        if (similar.results) {
          pool.push(
            ...similar.results.map(movie => ({
              ...movie,
              media_type: 'movie'
            }))
          );
        }
      } catch {
        // Ignore invalid favorites.
      }
    }

    // ---------------------------------------------------------
    // REMOVE DUPLICATES / PREVIOUSLY SHOWN MOVIES
    // ---------------------------------------------------------

    const unique = new Map();

    pool.forEach(movie => {
      const key = `${movie.media_type}-${movie.id}`;

      if (
        !excludedIds.has(String(movie.id)) &&
        !excludedIds.has(key) &&
        !unique.has(key)
      ) {
        unique.set(key, movie);
      }
    });

    const getYear = movie =>
      parseInt(
        (
          movie.release_date ||
          movie.first_air_date ||
          ''
        ).slice(0, 4),
        10
      );

    const movieText = movie =>
      [
        movie.title,
        movie.name,
        movie.overview
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    // ---------------------------------------------------------
    // HARD FILTERS
    // ---------------------------------------------------------

    let candidates = [...unique.values()].filter(movie => {
      const year = getYear(movie);

      // YEAR RANGE
      if (
        !Number.isFinite(year) ||
        year < lowerYear ||
        year > upperYear
      ) {
        return false;
      }

      // MINIMUM RATING
      if (
        rating > 0 &&
        Number(movie.vote_average || 0) < Number(rating)
      ) {
        return false;
      }

      // GENRE
      if (
        selectedGenres.length &&
        !(movie.genre_ids || []).some(genre =>
          selectedGenres.includes(Number(genre))
        )
      ) {
        return false;
      }

      // LANGUAGE
      if (
        selectedLanguages.length &&
        !selectedLanguages.includes(
          String(movie.original_language || '').toLowerCase()
        )
      ) {
        return false;
      }

      // MOOD
      if (selectedMoods.length) {
        const text = movieText(movie);

        const moodPass = selectedMoods.some(mood => {
          const genrePass =
            (movie.genre_ids || []).some(genre =>
              (moodGenreMap[mood] || []).includes(
                Number(genre)
              )
            );

          const textPass =
            (moodWords[mood] || []).some(word =>
              text.includes(word)
            );

          return genrePass || textPass;
        });

        if (!moodPass) {
          return false;
        }
      }

      return true;
    });

    // ---------------------------------------------------------
    // GET DETAILED INFORMATION
    // ---------------------------------------------------------

    const detailed = [];

    for (let i = 0; i < candidates.length; i += 12) {
      const batch = candidates.slice(i, i + 12);

      const results = await Promise.allSettled(
        batch.map(movie =>
          fetchFromTMDB(
            `/${movie.media_type}/${movie.id}`,
            {
              append_to_response: 'keywords'
            }
          )
        )
      );

      results.forEach((result, index) => {
        detailed.push(
          result.status === 'fulfilled'
            ? {
                ...batch[index],
                ...result.value
              }
            : batch[index]
        );
      });

      if (detailed.length >= 90) {
        break;
      }
    }

    candidates = detailed.filter(movie => {
      // COUNTRY
      if (selectedCountries.length) {
        const origins = movie.origin_country || [];

        if (
          !origins.some(countryCode =>
            selectedCountries.includes(countryCode)
          )
        ) {
          return false;
        }
      }

      // MOOD
      if (selectedMoods.length) {
        const text = [
          movie.title,
          movie.name,
          movie.overview,
          ...(movie.keywords?.keywords || [])
            .map(keyword => keyword.name)
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        const moodPass = selectedMoods.some(mood => {
          const genrePass =
            (
              movie.genres ||
              movie.genre_ids ||
              []
            )
              .map(genre => Number(genre.id ?? genre))
              .some(id =>
                (moodGenreMap[mood] || []).includes(id)
              );

          const textPass =
            (moodWords[mood] || []).some(word =>
              text.includes(word)
            );

          return genrePass || textPass;
        });

        if (!moodPass) {
          return false;
        }
      }

      return true;
    });

    // ---------------------------------------------------------
    // HASHTAG MATCHING
    // ---------------------------------------------------------

    const cleanTag = tag =>
      tag
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();

    const tags = selectedTags
      .map(cleanTag)
      .filter(Boolean);

    const hashtagScore = (movie, tag) => {
      const text = [
        movie.title,
        movie.name,
        movie.overview,
        ...(movie.keywords?.keywords || [])
          .map(keyword => keyword.name)
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ');

      if (!text) {
        return 0;
      }

      if (text.includes(tag)) {
        return 1;
      }

      const words = tag
        .split(' ')
        .filter(Boolean);

      if (!words.length) {
        return 0;
      }

      return (
        words.filter(word =>
          text.includes(word)
        ).length / words.length
      );
    };

    // ---------------------------------------------------------
    // FAVORITE GENRE PRIORITY
    // ---------------------------------------------------------

    const maxFavoriteFrequency = Math.max(
      1,
      ...favoriteGenreFrequency.values()
    );

    // ---------------------------------------------------------
    // FINAL SCORING
    // ---------------------------------------------------------

    const scored = candidates.map(movie => {
      let score = 0;

      const reasons = [];

      const movieGenres = (
        movie.genre_ids ||
        movie.genres?.map(genre => genre.id) ||
        []
      ).map(Number);

      // FAVORITE GENRES — HIGH PRIORITY
      const favoriteMatches =
        movieGenres.filter(genre =>
          favoriteGenreFrequency.has(genre)
        );

      if (favoriteMatches.length) {
        const favoriteScore =
          favoriteMatches.reduce(
            (sum, genre) =>
              sum +
              favoriteGenreFrequency.get(genre) /
                maxFavoriteFrequency,
            0
          );

        score += favoriteScore * 45;

        reasons.push(
          'Matches your favorite-movie genres'
        );
      }

      // SELECTED GENRES
      const selectedMatches =
        movieGenres.filter(genre =>
          selectedGenres.includes(genre)
        ).length;

      if (selectedMatches) {
        score += selectedMatches * 20;

        reasons.push(
          'Matches your selected genres'
        );
      }

      // STORY HASHTAGS
      if (tags.length) {
        const tagMatch = tags.reduce(
          (sum, tag) =>
            sum + hashtagScore(movie, tag),
          0
        );

        if (tagMatch > 0) {
          score += tagMatch * 35;

          reasons.push(
            'Matches your story themes'
          );
        }
      }

      // RATING
      const movieRating =
        Number(movie.vote_average || 0);

      const voteCount =
        Number(movie.vote_count || 0);

      score += movieRating * 4;

      // POPULARITY / HIT PRIORITY
      score +=
        Math.min(
          Number(movie.popularity || 0),
          100
        ) * 0.65;

      if (
        movieRating >= 7.5 &&
        voteCount >= 1000
      ) {
        score += 20;

        reasons.push('Popular hit');
      } else if (voteCount >= 500) {
        score += 8;
      }

      if (movieRating >= 8) {
        reasons.push('Highly rated');
      }

      // FAVORITE KEYWORDS
      if (
        favoriteKeywords.size &&
        movie.keywords?.keywords
      ) {
        const keywordMatches =
          movie.keywords.keywords.filter(keyword =>
            favoriteKeywords.has(
              String(keyword.name).toLowerCase()
            )
          ).length;

        if (keywordMatches) {
          score += keywordMatches * 8;

          reasons.push(
            'Shares themes with your favorites'
          );
        }
      }

      return {
        ...movie,
        score,
        matchReason:
          Array.from(
            new Set(reasons)
          )
            .slice(0, 3)
            .join(' • ') ||
          'Tailored match based on your preferences'
      };
    });

    scored.sort(
      (a, b) => b.score - a.score
    );

    res.json({
      total: scored.length,
      recommendations:
        scored.slice(0, 12)
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
});

// ---------------------------------------------------------
// EXISTING SERVER ROUTES / START SERVER
// ---------------------------------------------------------

app.listen(PORT, () => {
  console.log(`YourChoice running on port ${PORT}`);
});
