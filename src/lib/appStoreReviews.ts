import { SignJWT, importPKCS8 } from "jose";

const APP_STORE_CONNECT_API = "https://api.appstoreconnect.apple.com";
const REQUIRED_ENVIRONMENT_VARIABLES = [
  "APP_STORE_KEY_ID",
  "APP_STORE_ISSUER_ID",
  "APP_STORE_APP_ID",
  "APP_STORE_PRIVATE_KEY",
] as const;

export interface AppStoreReview {
  id: string;
  rating: number;
  title: string;
  body: string;
  createdDate: string;
  territory: string;
  developerResponse?: {
    body: string;
    lastModifiedDate: string;
  };
}

interface CustomerReviewResource {
  type: "customerReviews";
  id: string;
  attributes: {
    rating?: number;
    title?: string;
    body?: string;
    createdDate?: string;
    territory?: string;
    reviewTerritory?: string;
  };
  relationships?: {
    response?: {
      data?: {
        type: "customerReviewResponses";
        id: string;
      } | null;
    };
  };
}

interface CustomerReviewResponseResource {
  type: "customerReviewResponses";
  id: string;
  attributes: {
    responseBody?: string;
    lastModifiedDate?: string;
    state?: "PUBLISHED" | "PENDING_PUBLISH";
  };
}

interface CustomerReviewsResponse {
  data?: CustomerReviewResource[];
  included?: CustomerReviewResponseResource[];
  links?: {
    next?: string;
  };
}

function getEnvironmentVariable(name: string) {
  return process.env[name] || import.meta.env[name];
}

function getCredentials() {
  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter(
    (name) => !getEnvironmentVariable(name)?.trim(),
  );

  if (missing.length > 0) {
    const message = `Missing App Store Connect environment variables: ${missing.join(", ")}`;

    if (process.env.GITHUB_ACTIONS === "true") {
      throw new Error(message);
    }

    console.warn(
      `${message}. Skipping App Store reviews for this local build.`,
    );
    return null;
  }

  return {
    keyId: getEnvironmentVariable("APP_STORE_KEY_ID")!.trim(),
    issuerId: getEnvironmentVariable("APP_STORE_ISSUER_ID")!.trim(),
    appId: getEnvironmentVariable("APP_STORE_APP_ID")!.trim(),
    privateKey: getEnvironmentVariable("APP_STORE_PRIVATE_KEY")!
      .replace(/\\n/g, "\n")
      .trim(),
  };
}

async function createToken(
  credentials: NonNullable<ReturnType<typeof getCredentials>>,
) {
  const signingKey = await importPKCS8(credentials.privateKey, "ES256");

  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: credentials.keyId, typ: "JWT" })
    .setIssuer(credentials.issuerId)
    .setAudience("appstoreconnect-v1")
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(signingKey);
}

function normalizeReview(
  review: CustomerReviewResource,
  responses: Map<string, CustomerReviewResponseResource>,
): AppStoreReview | null {
  const { attributes } = review;

  if (
    (attributes.rating !== 4 && attributes.rating !== 5) ||
    !attributes.createdDate
  ) {
    return null;
  }

  const responseId = review.relationships?.response?.data?.id;
  const response = responseId ? responses.get(responseId) : undefined;
  const responseBody = response?.attributes.responseBody?.trim();

  return {
    id: review.id,
    rating: attributes.rating,
    title: attributes.title?.trim() || "App Store review",
    body: attributes.body?.trim() || "",
    createdDate: attributes.createdDate,
    territory: attributes.reviewTerritory || attributes.territory || "",
    developerResponse:
      response?.attributes.state === "PUBLISHED" && responseBody
        ? {
            body: responseBody,
            lastModifiedDate: response.attributes.lastModifiedDate || "",
          }
        : undefined,
  };
}

async function fetchAppStoreReviews(
  credentials: NonNullable<ReturnType<typeof getCredentials>>,
  token: string,
): Promise<AppStoreReview[]> {
  const firstPage = new URL(
    `/v1/apps/${encodeURIComponent(credentials.appId)}/customerReviews`,
    APP_STORE_CONNECT_API,
  );
  firstPage.searchParams.set("filter[rating]", "4,5");
  firstPage.searchParams.set("sort", "-createdDate");
  firstPage.searchParams.set("limit", "200");
  firstPage.searchParams.set("include", "response");
  firstPage.searchParams.set(
    "fields[customerReviews]",
    "rating,title,body,createdDate,territory,reviewTerritory,response",
  );
  firstPage.searchParams.set(
    "fields[customerReviewResponses]",
    "responseBody,lastModifiedDate,state",
  );

  const reviews = new Map<string, AppStoreReview>();
  const visitedPages = new Set<string>();
  let nextPage: string | undefined = firstPage.toString();

  while (nextPage) {
    const pageUrl = new URL(nextPage);

    if (pageUrl.origin !== APP_STORE_CONNECT_API) {
      throw new Error(
        "App Store Connect returned an unexpected pagination URL.",
      );
    }

    if (visitedPages.has(pageUrl.toString())) {
      throw new Error("App Store Connect returned a repeated pagination URL.");
    }
    visitedPages.add(pageUrl.toString());

    const response = await fetch(pageUrl, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      throw new Error(
        `App Store Connect customer reviews request failed with status ${response.status}.`,
      );
    }

    const page = (await response.json()) as CustomerReviewsResponse;
    const developerResponses = new Map(
      (page.included || [])
        .filter((resource) => resource.type === "customerReviewResponses")
        .map((resource) => [resource.id, resource]),
    );

    for (const resource of page.data || []) {
      const review = normalizeReview(resource, developerResponses);
      if (review) {
        reviews.set(review.id, review);
      }
    }

    nextPage = page.links?.next;
  }

  return [...reviews.values()].sort(
    (a, b) => Date.parse(b.createdDate) - Date.parse(a.createdDate),
  );
}

export async function getAppStoreReviews(): Promise<AppStoreReview[]> {
  const credentials = getCredentials();

  if (!credentials) {
    return [];
  }

  const token = await createToken(credentials);
  return fetchAppStoreReviews(credentials, token);
}
