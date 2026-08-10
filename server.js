const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

const TMDB_API_KEY = process.env.TMDB_API_KEY;

if (!TMDB_API_KEY) {
  console.warn("WARNING: TMDB_API_KEY is not set.");
}

/* =========================================================
   TMDB
========================================================= */

async function fetchFromTMDB(endpoint, params = {}) {
  const url = new URL(
    `https://api.themoviedb.org/3${endpoint}`
  );

  url.searchParams.set("api_key", TMDB_API_KEY);

  for (const [key, value] of Object.entries(params)) {
    if (
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `TMDB ${response.status}: ${await response.text()}`
    );
  }

  return response.json();
}

/* =========================================================
   SEARCH
========================================================= */

app.get("/api/search", async (req, res) => {
  try {
    const query = String(req.query.query || "").trim();

    if (!query) {
      return res.json({ results: [] });
    }

    const type = req.query.type || "multi";

    const endpoint =
      type === "person"
        ? "/search/person"
        : "/search/multi";

    const data = await fetchFromTMDB(endpoint, {
      query,
      include_adult: false
    });

    const results = (data.results || [])
      .filter(item =>
        type === "person"
          ? item.media_type === "person" || item.id
          : ["movie", "tv"].includes(item.media_type)
      )
      .slice(0, 12);

    res.json({ results });

  } catch (error) {
    console.error("Search error:", error.message);

    res.status(500).json({
      error: "Failed to search TMDB."
    });
  }
});

/* =========================================================
   DETAILS
========================================================= */

app.get("/api/details/:type/:id", async (req, res) => {
  try {
    const type =
      req.params.type === "tv"
        ? "tv"
        : "movie";

    const data = await fetchFromTMDB(
      `/${type}/${req.params.id}`,
      {
        append_to_response:
          "credits,watch/providers,keywords,release_dates"
      }
    );

    res.json(data);

  } catch (error) {
    console.error("Details error:", error.message);

    res.status(500).json({
      error: "Failed to fetch details."
    });
  }
});

/* =========================================================
   WATCH PROVIDERS
========================================================= */

app.get(
  "/api/providers/:type/:id",
  async (req, res) => {
    try {
      const type =
        req.params.type === "tv"
          ? "tv"
          : "movie";

      const region =
        req.query.region || "IN";

      const data =
        await fetchFromTMDB(
          `/${type}/${req.params.id}/watch/providers`
        );

      res.json({
        region,
        providers:
          data.results?.[region] || null
      });

    } catch (error) {
      console.error(
        "Providers error:",
        error.message
      );

      res.status(500).json({
        error: "Failed to fetch watch providers."
      });
    }
  }
);

/* =========================================================
   RECOMMENDATION ENGINE
=========================================================

   PRIORITY:

   1. HASHTAGS / SPECIFIC STORY THEME
   2. FAVOURITE MOVIES
   3. NEWER MOVIES WITHIN TIMELINE
   4. LANGUAGE
   5. GENRE
   6. MOOD
   7. MINIMUM RATING

   ADDITIONAL RULE:

   TOP 5
   -------
   Prefer SUPERHIT / BLOCKBUSTER movies
   that ALSO match the requested theme.

   NEVER use a random popular movie just to fill
   the recommendation list.

========================================================= */

app.post("/api/recommendations", async (req, res) => {
  try {

    const {
      mediaType = "both",

      moods = [],

      genres = [],

      favoriteIds = [],

      languages = [],

      countries = [],

      language = "any",

      country = "any",

      rating = 0,

      minYear = 1900,

      maxYear = new Date().getFullYear(),

      hashtags = [],

      watchedIds = [],

      recommendedIds = []
    } = req.body;


    /* =====================================================
       NORMALIZE INPUT
    ===================================================== */

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
            .filter(Number.isFinite)
        : [];


    const selectedLanguages =
      Array.isArray(languages) &&
      languages.length
        ? languages
            .map(String)
            .map(x =>
              x.toLowerCase()
            )
        : language !== "any"
          ? [String(language).toLowerCase()]
          : [];


    const selectedCountries =
      Array.isArray(countries) &&
      countries.length
        ? countries
            .map(String)
            .map(x =>
              x.toUpperCase()
            )
        : country !== "any"
          ? [String(country).toUpperCase()]
          : [];


    let fromYear =
      Number(minYear);

    let toYear =
      Number(maxYear);


    if (!Number.isFinite(fromYear)) {
      fromYear = 1900;
    }

    if (!Number.isFinite(toYear)) {
      toYear = new Date().getFullYear();
    }


    fromYear = Math.max(
      1900,
      Math.min(
        fromYear,
        new Date().getFullYear()
      )
    );


    toYear = Math.max(
      1900,
      Math.min(
        toYear,
        new Date().getFullYear()
      )
    );


    if (fromYear > toYear) {
      [fromYear, toYear] =
        [toYear, fromYear];
    }


    const selectedTags =
      Array.isArray(hashtags)
        ? hashtags
            .map(tag =>
              String(tag)
                .replace(/^#/, "")
                .trim()
                .toLowerCase()
            )
            .filter(Boolean)
        : [];


    /* =====================================================
       EXCLUSIONS
    ===================================================== */

    const excluded =
      new Set([
        ...watchedIds,
        ...recommendedIds
      ].map(String));


    const favoriteSet =
      new Set(
        favoriteIds.map(String)
      );


    /* =====================================================
       TEXT NORMALIZATION
    ===================================================== */

    const normalizeText = value =>
      String(value || "")
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\w\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();


    const movieText = movie =>
      normalizeText([
        movie.title,
        movie.name,
        movie.overview,

        ...(movie.tagline
          ? [movie.tagline]
          : []),

        ...(movie.keywords?.keywords || [])
          .map(k => k.name)
      ].join(" "));


    const movieGenres = movie =>
      (
        movie.genre_ids ||
        movie.genres?.map(
          g => g.id
        ) ||
        []
      ).map(Number);


    const releaseYear = movie =>
      Number(
        String(
          movie.release_date ||
          movie.first_air_date ||
          ""
        ).slice(0, 4)
      );


    const movieKey = movie =>
      `${movie.media_type}-${movie.id}`;


    /* =====================================================
       SPECIFIC THEME DICTIONARY

       This is what prevents:

       #superhero
       from becoming merely "action".

       It gives specific concepts a group of related
       words/keywords.

    ===================================================== */

    const themeDictionary = {

      superhero: [
        "superhero",
        "super hero",
        "super-powered",
        "superpowered",
        "super power",
        "superpowers",
        "masked hero",
        "comic book",
        "vigilante",
        "cape",
        "metahuman",
        "hero",
        "superhuman"
      ],

      gangster: [
        "gangster",
        "gangsters",
        "mob",
        "mafia",
        "organized crime",
        "crime family",
        "underworld",
        "mobster",
        "mobsters",
        "cartel",
        "criminal organization"
      ],

      entrepreneurship: [
        "entrepreneur",
        "entrepreneurship",
        "businessman",
        "businesswoman",
        "business",
        "startup",
        "founder",
        "company",
        "corporation",
        "business empire",
        "entrepreneurial"
      ],

      commonman: [
        "common man",
        "ordinary man",
        "ordinary person",
        "ordinary people",
        "everyman",
        "common person",
        "working class",
        "middle class",
        "ordinary citizen"
      ],

      fighter: [
        "fighter",
        "warrior",
        "combat",
        "martial arts",
        "boxing",
        "wrestling",
        "fighter pilot",
        "soldier",
        "warrior"
      ],

      vigilante: [
        "vigilante",
        "masked vigilante",
        "crime fighter",
        "justice",
        "taking justice",
        "takes justice"
      ],

      detective: [
        "detective",
        "detective investigation",
        "private investigator",
        "investigator",
        "mystery",
        "case",
        "investigation"
      ],

      spy: [
        "spy",
        "spies",
        "espionage",
        "secret agent",
        "agent",
        "intelligence agency",
        "undercover agent"
      ],

      heist: [
        "heist",
        "robbery",
        "robbers",
        "bank robbery",
        "thieves",
        "thief",
        "stealing",
        "burglary"
      ],

      revenge: [
        "revenge",
        "revenge mission",
        "revenge story",
        "avenging",
        "avenge",
        "vengeance"
      ],

      survival: [
        "survival",
        "survive",
        "stranded",
        "trapped",
        "survivor",
        "wilderness"
      ]
    };


    /* =====================================================
       THEME EXPANSION
    ===================================================== */

    function getThemeTerms(tag) {

      const normalized =
        normalizeText(tag)
          .replace(/\s+/g, "");

      for (
        const [theme, terms]
        of Object.entries(
          themeDictionary
        )
      ) {

        const normalizedTheme =
          normalizeText(theme)
            .replace(/\s+/g, "");

        if (
          normalized ===
          normalizedTheme
        ) {
          return terms;
        }
      }

      return [
        normalizeText(tag)
      ];
    }


    /* =====================================================
       MOOD
    ===================================================== */

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

      "thought-provoking": [
        878,
        9648,
        18,
        99
      ],

      "feel-good": [
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
        "funny",
        "comedy",
        "humor",
        "hilarious",
        "laugh"
      ],

      scary: [
        "horror",
        "haunted",
        "ghost",
        "monster",
        "terror",
        "demon"
      ],

      romantic: [
        "love",
        "romance",
        "romantic",
        "relationship",
        "couple"
      ],

      exciting: [
        "action",
        "mission",
        "battle",
        "fight",
        "chase",
        "escape",
        "adventure"
      ],

      dark: [
        "dark",
        "crime",
        "murder",
        "killer",
        "revenge",
        "corruption"
      ],

      emotional: [
        "emotional",
        "family",
        "loss",
        "grief",
        "struggle",
        "love"
      ],

      "thought-provoking": [
        "truth",
        "identity",
        "science",
        "future",
        "society",
        "humanity",
        "philosophy"
      ],

      "feel-good": [
        "hope",
        "friendship",
        "dream",
        "joy",
        "success",
        "family"
      ],

      suspenseful: [
        "mystery",
        "detective",
        "investigation",
        "secret",
        "crime",
        "killer",
        "thriller"
      ],

      adventurous: [
        "adventure",
        "journey",
        "quest",
        "explore",
        "expedition",
        "survival"
      ],

      inspiring: [
        "dream",
        "ambition",
        "success",
        "overcome",
        "achievement",
        "inspire",
        "struggle"
      ]
    };


    /* =====================================================
       FAVORITE MOVIE PROFILE
    ===================================================== */

    const favoriteGenreFrequency =
      new Map();

    const favoriteKeywordFrequency =
      new Map();


    for (
      const favoriteId of favoriteIds
    ) {

      try {

        const favorite =
          await fetchFromTMDB(
            `/movie/${favoriteId}`,
            {
              append_to_response:
                "keywords,credits"
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
          favorite.keywords?.keywords ||
          []
        ) {

          const word =
            normalizeText(
              keyword.name
            );

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


    /* =====================================================
       DETECT WHETHER A HASHTAG IS STRONGLY CONFIRMED
       BY THE FAVORITE MOVIES
    ===================================================== */

    function favoriteSupportsTheme(
      tag
    ) {

      const terms =
        getThemeTerms(tag);

      let score = 0;

      for (
        const keyword
        of favoriteKeywordFrequency.keys()
      ) {

        for (
          const term of terms
        ) {

          const normalizedTerm =
            normalizeText(term);

          if (
            keyword.includes(
              normalizedTerm
            ) ||
            normalizedTerm.includes(
              keyword
            )
          ) {

            score +=
              favoriteKeywordFrequency.get(
                keyword
              ) || 0;

            break;
          }
        }
      }

      /*
        Also use the overview/genre information
        indirectly through common superhero etc.
      */

      return score >= 2;
    }


    /* =====================================================
       CANDIDATE COLLECTION
    ===================================================== */

    const candidates =
      new Map();


    function addCandidates(
      results,
      type
    ) {

      for (
        const item of results || []
      ) {

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
      mediaType === "both"
        ? ["movie", "tv"]
        : [mediaType];


    /* =====================================================
       DISCOVER MOVIES

       NO /POPULAR FALLBACK.

       Every candidate comes from the requested
       year range and selected basic preferences.
    ===================================================== */

    for (
      const type of types
    ) {

      const base = {

        sort_by:
          "popularity.desc",

        include_adult:
          false,

        "vote_count.gte":
          50
      };


      if (
        selectedGenres.length
      ) {

        base.with_genres =
          selectedGenres.join("|");
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


      if (type === "movie") {

        base[
          "primary_release_date.gte"
        ] =
          `${fromYear}-01-01`;

        base[
          "primary_release_date.lte"
        ] =
          `${toYear}-12-31`;

      } else {

        base[
          "first_air_date.gte"
        ] =
          `${fromYear}-01-01`;

        base[
          "first_air_date.lte"
        ] =
          `${toYear}-12-31`;
      }


      for (
        let page = 1;
        page <= 8;
        page++
      ) {

        try {

          const data =
            await fetchFromTMDB(
              `/discover/${type}`,
              {
                ...base,
                page
              }
            );


          addCandidates(
            data.results,
            type
          );

        } catch (error) {

          console.error(
            "Discover error:",
            error.message
          );
        }
      }
    }


    /* =====================================================
       FAVORITE SIMILAR
    ===================================================== */

    for (
      const favoriteId
      of favoriteIds
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
          "movie"
        );

      } catch {
        // Ignore.
      }
    }


    /* =====================================================
       DETAILS
    ===================================================== */

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
                  "keywords,release_dates"
              }
            )
          )
        );


      results.forEach(
        (result, index) => {

          detailed.push(

            result.status ===
            "fulfilled"

              ? {
                  ...batch[index],
                  ...result.value
                }

              : batch[index]
          );
        }
      );
    }


    /* =====================================================
       HARD FILTERS
    ===================================================== */

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
              ""
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
            movie.origin_country ||
            [];


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


    /* =====================================================
       KIDS MOVIE FILTER
    ===================================================== */

    function clearlyKidsMovie(movie) {

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
        "kids",
        "children",
        "child",
        "preschool",
        "young children",
        "family friendly",
        "family film",
        "educational",
        "children's"
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
        Do NOT reject all family movies.

        Only reject clearly child-targeted
        content.
      */

      return (
        family &&
        (kidsText || kidsKeyword)
      );
    }


    let usable =
      filtered.filter(
        movie =>
          !clearlyKidsMovie(movie)
      );


    /* =====================================================
       HASHTAG MATCHING
    ===================================================== */

    function hashtagMatch(
      movie,
      tag
    ) {

      const text =
        movieText(movie);

      const terms =
        getThemeTerms(tag);


      let best = 0;


      for (
        const term of terms
      ) {

        const normalized =
          normalizeText(term);


        if (
          !normalized
        ) {
          continue;
        }


        if (
          text.includes(normalized)
        ) {

          /*
            Exact theme term gets
            a strong match.
          */

          best =
            Math.max(
              best,
              normalized.length > 7
                ? 1
                : 0.8
            );
        }
      }


      /*
        Also check individual words
        in custom hashtags.
      */

      if (
        best === 0
      ) {

        const words =
          normalizeText(tag)
            .split(" ")
            .filter(Boolean);


        if (words.length) {

          const matched =
            words.filter(word =>
              text.includes(word)
            ).length;


          best =
            matched /
            words.length;
        }
      }


      return best;
    }


    function totalHashtagScore(
      movie
    ) {

      if (
        !selectedTags.length
      ) {
        return 0;
      }


      let total = 0;


      for (
        const tag
        of selectedTags
      ) {

        total +=
          hashtagMatch(
            movie,
            tag
          );
      }


      return (
        total /
        selectedTags.length
      );
    }


    /* =====================================================
       STRONG THEME FILTER
       
       Example:

       Favourite:
       Spider-Man
       Batman
       Iron Man

       Hashtag:
       #superhero

       Then non-superhero movies are removed.
    ===================================================== */

    const confirmedThemes =
      selectedTags.filter(tag =>
        favoriteSupportsTheme(tag)
      );


    if (
      confirmedThemes.length
    ) {

      const themeFiltered =
        usable.filter(movie => {

          return confirmedThemes.every(
            tag =>
              hashtagMatch(
                movie,
                tag
              ) >= 0.45
          );
        });


      /*
        Only apply the hard theme filter
        if it still leaves a reasonable
        candidate pool.

        This prevents a bad TMDB description
        from making the whole page empty.
      */

      if (
        themeFiltered.length >= 8
      ) {

        usable =
          themeFiltered;

      } else if (
        themeFiltered.length > 0
      ) {

        /*
          Keep matching movies and only
          add highly relevant fallback
          candidates.
        */

        const strongMatches =
          usable.filter(movie => {

            return confirmedThemes.every(
              tag =>
                hashtagMatch(
                  movie,
                  tag
                ) >= 0.7
            );
          });


        if (
          strongMatches.length
        ) {

          usable =
            strongMatches;
        }
      }
    }


    /* =====================================================
       SCORES
    ===================================================== */

    function favoriteScore(movie) {

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
    }


    function timelineScore(movie) {

      const year =
        releaseYear(movie);


      if (
        !Number.isFinite(year)
      ) {
        return 0;
      }


      /*
        NEWER = BETTER.

        Oldest selected year:
        0

        Newest selected year:
        1
      */

      if (
        toYear === fromYear
      ) {
        return 1;
      }


      return (
        year - fromYear
      ) /
      (
        toYear - fromYear
      );
    }


    function languageScore(movie) {

      if (
        !selectedLanguages.length
      ) {
        return 0.5;
      }


      return selectedLanguages.includes(
        String(
          movie.original_language ||
          ""
        ).toLowerCase()
      )
        ? 1
        : 0;
    }


    function genreScore(movie) {

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
    }


    function moodScore(movie) {

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
        const mood
        of selectedMoods
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
    }


    function ratingScore(movie) {

      const value =
        Number(
          movie.vote_average || 0
        );


      return Math.min(
        value / 10,
        1
      );
    }


    /* =====================================================
       BLOCKBUSTER / SUPERHIT DETECTION
       
       IMPORTANT:
       A movie is considered a strong hit only when
       BOTH popularity and audience reception support it.

       This prevents a random popular movie from entering
       the top 5.
    ===================================================== */

    function blockbusterScore(movie) {

      const rating =
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


      /*
        Very strong audience success.
      */

      if (
        rating >= 8 &&
        votes >= 5000
      ) {

        score = 1;
      }

      else if (
        rating >= 7.5 &&
        votes >= 2500
      ) {

        score = 0.9;
      }

      else if (
        rating >= 7.2 &&
        votes >= 1500
      ) {

        score = 0.75;
      }

      else if (
        rating >= 7 &&
        votes >= 750
      ) {

        score = 0.6;
      }


      /*
        Popularity strengthens the hit status.
      */

      if (
        popularity >= 100
      ) {

        score =
          Math.min(
            1,
            score + 0.25
          );

      } else if (
        popularity >= 60
      ) {

        score =
          Math.min(
            1,
            score + 0.15
          );
      }


      return score;
    }


    /* =====================================================
       TOP 5 THEME HIT SCORE
    ===================================================== */

    function topFiveHitScore(movie) {

      const theme =
        totalHashtagScore(movie);

      const favorite =
        favoriteScore(movie);

      const blockbuster =
        blockbusterScore(movie);


      /*
        Theme MUST matter.

        A blockbuster with no thematic
        relationship is NOT a top-five pick.
      */

      if (
        selectedTags.length
      ) {

        if (
          theme < 0.45
        ) {

          return 0;
        }


        return (
          theme *
          0.65
        ) +
        (
          blockbuster *
          0.35
        );
      }


      /*
        If no hashtag is given,
        use favorite similarity + hit status.
      */

      return (
        favorite *
        0.55
      ) +
      (
        blockbuster *
        0.45
      );
    }


    /* =====================================================
       BUILD SCORED LIST
    ===================================================== */

    const scored =
      usable.map(movie => {

        const hashtag =
          totalHashtagScore(movie);

        const favorite =
          favoriteScore(movie);

        const timeline =
          timelineScore(movie);

        const languageMatch =
          languageScore(movie);

        const genre =
          genreScore(movie);

        const mood =
          moodScore(movie);

        const ratingMatch =
          ratingScore(movie);

        const blockbuster =
          blockbusterScore(movie);

        const topFiveHit =
          topFiveHitScore(movie);


        /*
          IMPORTANT:

          Lexicographic ranking.

          Higher priority values are compared first.

          Therefore:

          Hashtag > Favorite > Timeline >
          Language > Genre > Mood > Rating
        */

        const priorityVector = [

          Math.round(
            hashtag * 10000
          ),

          Math.round(
            favorite * 10000
          ),

          Math.round(
            timeline * 10000
          ),

          Math.round(
            languageMatch * 10000
          ),

          Math.round(
            genre * 10000
          ),

          Math.round(
            mood * 10000
          ),

          Math.round(
            ratingMatch * 10000
          )
        ];


        return {

          ...movie,

          _hashtagScore:
            hashtag,

          _favoriteScore:
            favorite,

          _timelineScore:
            timeline,

          _languageScore:
            languageMatch,

          _genreScore:
            genre,

          _moodScore:
            mood,

          _ratingScore:
            ratingMatch,

          _blockbusterScore:
            blockbuster,

          _topFiveHitScore:
            topFiveHit,

          _priorityVector:
            priorityVector
        };
      });


    /* =====================================================
       NORMAL SORT
    ===================================================== */

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


        /*
          Same preferences:

          Newer first.
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
          Then hit movies.
        */

        if (
          b._blockbusterScore !==
          a._blockbusterScore
        ) {

          return (
            b._blockbusterScore -
            a._blockbusterScore
          );
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


    /* =====================================================
       SPECIAL TOP 5
       
       RULE:

       Top five should be superhit/blockbuster
       movies INSIDE the requested type/theme.

       We do NOT simply take the five most popular
       movies.
    ===================================================== */

    const topFiveEligible =
      scored
        .filter(movie => {

          /*
            If hashtag exists, the movie must
            actually match the hashtag.
          */

          if (
            selectedTags.length &&
            movie._hashtagScore < 0.45
          ) {
            return false;
          }


          /*
            Must be a genuine hit.
          */

          if (
            movie._blockbusterScore < 0.6
          ) {
            return false;
          }


          return true;
        })
        .sort(
          (a, b) => {

            /*
              Theme first.
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
              Favorite similarity second.
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
              Newer third.
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
              Blockbuster strength fourth.
            */

            return (
              b._blockbusterScore -
              a._blockbusterScore
            );
          }
        );


    /* =====================================================
       SELECT TOP FIVE
    ===================================================== */

    const topFive =
      topFiveEligible.slice(
        0,
        Math.min(
          5,
          topFiveEligible.length
        )
      );


    const topFiveIds =
      new Set(
        topFive.map(
          movie =>
            movieKey(movie)
        )
      );


    /* =====================================================
       FILL REMAINING 7
       
       IMPORTANT:

       We don't fill with random popular movies.

       We use the normal recommendation ranking.
    ===================================================== */

    const remaining =
      scored.filter(
        movie =>
          !topFiveIds.has(
            movieKey(movie)
          )
      );


    const finalMovies = [
      ...topFive,
      ...remaining
    ].slice(0, 12);


    /* =====================================================
       CLEAN RESPONSE
    ===================================================== */

    const recommendations =
      finalMovies.map(movie => {

        const clean = {
          ...movie
        };


        const reasons = [];


        if (
          clean._hashtagScore > 0
        ) {

          reasons.push(
            "Matches your story hashtags"
          );
        }


        if (
          clean._favoriteScore > 0
        ) {

          reasons.push(
            "Similar to your favorite movies"
          );
        }


        if (
          clean._timelineScore >= 0.7
        ) {

          reasons.push(
            "Newer within your selected timeline"
          );
        }


        if (
          clean._languageScore === 1
        ) {

          reasons.push(
            "Matches your language"
          );
        }


        if (
          clean._genreScore > 0 &&
          clean._genreScore !== 0.5
        ) {

          reasons.push(
            "Matches your selected genre"
          );
        }


        if (
          clean._moodScore > 0 &&
          clean._moodScore !== 0.5
        ) {

          reasons.push(
            "Fits your mood"
          );
        }


        if (
          clean._blockbusterScore >= 0.75
        ) {

          reasons.push(
            "Superhit / blockbuster"
          );
        }


        clean.matchReason =
          reasons
            .slice(0, 3)
            .join(" • ") ||
          "Matches your preferences";


        delete clean._hashtagScore;
        delete clean._favoriteScore;
        delete clean._timelineScore;
        delete clean._languageScore;
        delete clean._genreScore;
        delete clean._moodScore;
        delete clean._ratingScore;
        delete clean._blockbusterScore;
        delete clean._topFiveHitScore;
        delete clean._priorityVector;


        return clean;
      });


    /* =====================================================
       RESPONSE
    ===================================================== */

    res.json({

      total:
        recommendations.length,

      recommendations
    });

  } catch (error) {

    console.error(
      "Recommendation error:",
      error
    );

    res.status(500).json({
      error:
        "Failed to generate recommendations."
    });
  }
});


/* =========================================================
   START SERVER
========================================================= */

app.listen(PORT, () => {

  console.log(
    `YourChoice running on port ${PORT}`
  );

});
