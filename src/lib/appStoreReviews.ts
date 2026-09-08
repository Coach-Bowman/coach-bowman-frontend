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
  reviewerNickname: string;
  createdDate: string;
  territory: string;
}

interface CustomerReviewResource {
  type: "customerReviews";
  id: string;
  attributes: {
    rating?: number;
    title?: string;
    body?: string;
    reviewerNickname?: string;
    createdDate?: string;
    territory?: string;
    reviewTerritory?: string;
  };
}

interface CustomerReviewsResponse {
  data?: CustomerReviewResource[];
  links?: {
    next?: string;
  };
}

function getCredentials() {
  const missing = REQUIRED_ENVIRONMENT_VARIABLES.filter(
    (name) => !process.env[name]?.trim(),
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
    keyId: process.env.APP_STORE_KEY_ID!.trim(),
    issuerId: process.env.APP_STORE_ISSUER_ID!.trim(),
    appId: process.env.APP_STORE_APP_ID!.trim(),
    privateKey: process.env.APP_STORE_PRIVATE_KEY!.replace(/\\n/g, "\n").trim(),
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
): AppStoreReview | null {
  const { attributes } = review;

  if (
    (attributes.rating !== 4 && attributes.rating !== 5) ||
    !attributes.createdDate
  ) {
    return null;
  }

  return {
    id: review.id,
    rating: attributes.rating,
    title: attributes.title?.trim() || "App Store review",
    body: attributes.body?.trim() || "",
    reviewerNickname:
      attributes.reviewerNickname?.trim() || "App Store customer",
    createdDate: attributes.createdDate,
    territory: attributes.reviewTerritory || attributes.territory || "",
  };
}

export async function getAppStoreReviews(): Promise<AppStoreReview[]> {
  const credentials = getCredentials();

  if (!credentials) {
    return [];
  }

  const token = await createToken(credentials);
  const firstPage = new URL(
    `/v1/apps/${encodeURIComponent(credentials.appId)}/customerReviews`,
    APP_STORE_CONNECT_API,
  );
  firstPage.searchParams.set("filter[rating]", "4,5");
  firstPage.searchParams.set("sort", "-createdDate");
  firstPage.searchParams.set("limit", "200");
  firstPage.searchParams.set(
    "fields[customerReviews]",
    "rating,title,body,reviewerNickname,createdDate,territory,reviewTerritory",
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

    for (const resource of page.data || []) {
      const review = normalizeReview(resource);
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
