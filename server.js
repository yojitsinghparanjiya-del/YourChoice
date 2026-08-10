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

// Simple In-Memory Cache
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes

async function fetchFromTMDB(endpoint, params = {}) {
  if (!TMDB_API_KEY || TMDB_API_KEY === 'YOUR_TMDB_API_KEY_HERE') {
    throw new Error('TMDB API Key is not configured in .env');
  }

  const queryParams = new URLSearchParams({
    api_key: TMDB_API_KEY,
    ...params
  });

  const url = `${TMDB_BASE_URL}${endpoint}?${queryParams.toString()}`;

  if (cache.has(url)) {
    const { timestamp, data } = cache.get(url);
    if (Date.now() - timestamp < CACHE_TTL) {
      return data;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`TMDB HTTP error! Status: ${response.status}`);
  }

  const data = await response.json();
  cache.set(url, { timestamp: Date.now(), data });
  return data;
}

// ---------------- API ENDPOINTS ----------------

// Live search for auto-complete & general search
app.get('/api/search', async (req, res) => {
  try {
    const { query, type = 'multi' } = req.query;
    if (!query || query.trim().length < 2) {
      return res.json({ results: [] });
    }

    const endpoint = type === 'person' ? '/search/person' : '/search/multi';
    const data = await fetchFromTMDB(endpoint, { query, include_adult: false });
    
    // Normalize and filter valid results
    const results = (data.results || []).filter(item => 
      ['movie', 'tv', 'person'].includes(item.media_type) || type === 'person'
    ).slice(0, 8);

    res.json({ results });
  } catch (error) {
    console.error('Search error:', error.message);
    res.status(500).json({ error: 'Failed to search TMDB.' });
  }
});

// Single movie or TV details
app.get('/api/details/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const mediaType = type === 'tv' ? 'tv' : 'movie';
    const data = await fetchFromTMDB(`/${mediaType}/${id}`, {
      append_to_response: 'credits,watch/providers,keywords'
    });
    res.json(data);
  } catch (error) {
    console.error('Details error:', error.message);
    res.status(500).json({ error: 'Failed to fetch details.' });
  }
});

// Watch providers
app.get('/api/providers/:type/:id', async (req, res) => {
  try {
    const { type, id } = req.params;
    const region = req.query.region || 'IN';
    const mediaType = type === 'tv' ? 'tv' : 'movie';
    const data = await fetchFromTMDB(`/${mediaType}/${id}/watch/providers`);
    const regionData = data.results ? data.results[region] || null : null;
    res.json({ region, providers: regionData });
  } catch (error) {
    console.error('Providers error:', error.message);
    res.status(500).json({ error: 'Failed to fetch watch providers.' });
  }
});

// Core Recommendation Engine
app.post('/api/recommendations', async (req, res) => {
  try {
    const {
      mediaType = 'both', // 'movie', 'tv', 'both'
      moods = [],
      genres = [],
      favoriteIds = [],
      runtime = 'any',
      language = 'any',
      country = 'any',
      rating = 0,
      releasePeriod = 'any',
      hashtags = [],
      watchedIds = []
    } = req.body;

    let candidatePool = [];
    const favoriteCredits = { cast: new Set(), crew: new Set(), genres: new Set(), keywords: new Set() };

    // 1. Process Favorites to extract deep connections
    for (const favId of favoriteIds) {
      try {
        const item = await fetchFromTMDB(`/movie/${favId}`, { append_to_response: 'credits,keywords,similar' });
        
        if (item.genres) item.genres.forEach(g => favoriteCredits.genres.add(g.id));
        if (item.credits?.cast) item.credits.cast.slice(0, 5).forEach(c => favoriteCredits.cast.add(c.id));
        if (item.credits?.crew) {
          item.credits.crew.filter(c => c.job === 'Director').forEach(d => favoriteCredits.crew.add(d.id));
        }
        if (item.keywords?.keywords) item.keywords.keywords.forEach(k => favoriteCredits.keywords.add(k.id));

        // Gather similar movies directly
        if (item.similar?.results) {
          candidatePool.push(...item.similar.results.map(r => ({ ...r, media_type: 'movie' })));
        }
      } catch (err) {
        // Skip invalid favorite IDs gracefully
      }
    }

    // 2. Resolve Hashtags to Person IDs or Keyword IDs
    const hashtagPeopleIds = [];
    for (const tag of hashtags) {
      const cleanTag = tag.replace(/^#/, '').trim();
      if (!cleanTag) continue;
      try {
        const searchRes = await fetchFromTMDB('/search/person', { query: cleanTag });
        if (searchRes.results && searchRes.results.length > 0) {
          hashtagPeopleIds.push(searchRes.results[0].id);
        }
      } catch (err) {
        // Ignore hashtag search errors
      }
    }

    // 3. Perform TMDB Discover Queries
    const typesToFetch = mediaType === 'both' ? ['movie', 'tv'] : [mediaType];

    for (const type of typesToFetch) {
      const discoverParams = {
        sort_by: 'popularity.desc',
        'vote_count.gte': 50,
        page: 1
      };

      if (genres.length > 0) {
        discoverParams.with_genres = genres.join(',');
      }

      if (language !== 'any') {
        discoverParams.with_original_language = language;
      }

      if (country !== 'any') {
        discoverParams.with_origin_country = country;
      }

      if (rating > 0) {
        discoverParams['vote_average.gte'] = rating;
      }

      if (hashtagPeopleIds.length > 0) {
        discoverParams.with_cast = hashtagPeopleIds.join(',');
      }

      // Date ranges for release periods
      if (releasePeriod !== 'any') {
        const year = parseInt(releasePeriod);
        if (!isNaN(year)) {
          const startYear = year - 5;
          const endYear = year + 5;
          if (type === 'movie') {
            discoverParams['primary_release_date.gte'] = `${startYear}-01-01`;
            discoverParams['primary_release_date.lte'] = `${endYear}-12-31`;
          } else {
            discoverParams['first_air_date.gte'] = `${startYear}-01-01`;
            discoverParams['first_air_date.lte'] = `${endYear}-12-31`;
          }
        }
      }

      // Fetch Discover Page 1 & 2 for rich candidate diversity
      const [p1, p2] = await Promise.allSettled([
        fetchFromTMDB(`/discover/${type}`, discoverParams),
        fetchFromTMDB(`/discover/${type}`, { ...discoverParams, page: 2 })
      ]);

      if (p1.status === 'fulfilled' && p1.value.results) {
        candidatePool.push(...p1.value.results.map(item => ({ ...item, media_type: type })));
      }
      if (p2.status === 'fulfilled' && p2.value.results) {
        candidatePool.push(...p2.value.results.map(item => ({ ...item, media_type: type })));
      }
    }

    // Fallback: If discover was too strict, grab general popular items
    if (candidatePool.length < 10) {
      for (const type of typesToFetch) {
        const popData = await fetchFromTMDB(`/${type}/popular`);
        if (popData.results) {
          candidatePool.push(...popData.results.map(item => ({ ...item, media_type: type })));
        }
      }
    }

    // 4. Deduplicate candidates and exclude already watched/favorite items
    const uniqueMap = new Map();
    const excludeSet = new Set([...watchedIds.map(String), ...favoriteIds.map(String)]);

    candidatePool.forEach(item => {
      const key = `${item.media_type}-${item.id}`;
      if (!excludeSet.has(String(item.id)) && !uniqueMap.has(key)) {
        uniqueMap.set(key, item);
      }
    });

    const uniqueCandidates = Array.from(uniqueMap.values());

    // 5. Intelligent Multi-Factor Scoring Engine
    const scoredResults = uniqueCandidates.map(item => {
      let score = 0;
      const reasons = [];

      // A. Genre Match
      if (item.genre_ids && genres.length > 0) {
        const matchCount = item.genre_ids.filter(g => genres.includes(g)).length;
        if (matchCount > 0) {
          score += matchCount * 15;
          reasons.push('Matches your selected genres');
        }
      }

      // B. Favorite Movie Similarity
      if (item.genre_ids && favoriteCredits.genres.size > 0) {
        const favGenreMatch = item.genre_ids.filter(g => favoriteCredits.genres.has(g)).length;
        if (favGenreMatch > 0) {
          score += favGenreMatch * 10;
          reasons.push('Shares themes with your favorite movies');
        }
      }

      // C. Rating Bonus
      if (item.vote_average) {
        score += item.vote_average * 2.5;
        if (item.vote_average >= 8.0) {
          reasons.push('Critically acclaimed');
        }
      }

      // D. Language / Country
      if (language !== 'any' && item.original_language === language) {
        score += 20;
        reasons.push(`Matches preferred language (${language.toUpperCase()})`);
      }

      // E. Release Period Soft Matching
      const releaseYear = parseInt((item.release_date || item.first_air_date || '').substring(0, 4));
      if (!isNaN(releaseYear) && releasePeriod !== 'any') {
        const targetYear = parseInt(releasePeriod);
        if (!isNaN(targetYear)) {
          const diff = Math.abs(releaseYear - targetYear);
          if (diff <= 3) {
            score += 20;
            reasons.push(`Released around your target era (${releaseYear})`);
          } else if (diff <= 7) {
            score += 10;
          }
        }
      }

      // F. Mood Boost (Map moods to relevant genres)
      const moodGenreMap = {
        'funny': [35],
        'scary': [27],
        'romantic': [10749],
        'exciting': [28, 12],
        'dark': [80, 9648, 53],
        'emotional': [18],
        'thought-provoking': [878, 99],
        'feel-good': [35, 10751],
        'suspenseful': [53, 9648]
      };

      moods.forEach(mood => {
        const mappedGenres = moodGenreMap[mood.toLowerCase()] || [];
        if (item.genre_ids && item.genre_ids.some(g => mappedGenres.includes(g))) {
          score += 12;
          reasons.push(`Fits your ${mood.toLowerCase()} mood`);
        }
      });

      // Popularity nudge
      score += Math.min(item.popularity || 0, 15) * 0.2;

      // Unique explanation generator
      const uniqueReasons = Array.from(new Set(reasons));
      const matchReason = uniqueReasons.length > 0 
        ? uniqueReasons.slice(0, 2).join(' • ')
        : 'Tailored match based on your preferences';

      return {
        ...item,
        score,
        matchReason
      };
    });

    // 6. Sort by Score descending and select top recommendations
    scoredResults.sort((a, b) => b.score - a.score);

    res.json({
      total: scoredResults.length,
      recommendations: scoredResults.slice(0, 12)
    });

  } catch (error) {
    console.error('Recommendation Error:', error);
    res.status(500).json({ error: 'Failed to generate recommendations.' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`===================================================`);
  console.log(`YourChoice Web App is running on http://localhost:${PORT}`);
  console.log(`===================================================`);
});
