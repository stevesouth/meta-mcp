import fetch from "node-fetch";
import { AuthManager } from "./utils/auth.js";
import { globalRateLimiter } from "./utils/rate-limiter.js";
import {
  MetaApiErrorHandler,
  retryWithBackoff,
} from "./utils/error-handler.js";
import {
  PaginationHelper,
  type PaginationParams,
  type PaginatedResult,
} from "./utils/pagination.js";
import type {
  Campaign,
  AdSet,
  Ad,
  AdCreative,
  AdInsights,
  CustomAudience,
  AdAccount,
  MetaApiResponse,
  BatchRequest,
  BatchResponse,
} from "./types/meta-api.js";

export class MetaApiClient {
  private auth: AuthManager;
  private requestTimeoutMs: number;
  private debugEnabled: boolean;

  constructor(
    auth?: AuthManager,
    options: { requestTimeoutMs?: number; debug?: boolean } = {}
  ) {
    this.auth = auth || AuthManager.fromEnvironment();
    const envTimeoutMs = Number(process.env.META_MCP_REQUEST_TIMEOUT_MS);
    const optionTimeoutMs =
      typeof options.requestTimeoutMs === "number" &&
      Number.isFinite(options.requestTimeoutMs)
        ? options.requestTimeoutMs
        : undefined;
    this.requestTimeoutMs =
      optionTimeoutMs ?? (Number.isFinite(envTimeoutMs) ? envTimeoutMs : 30000);
    this.debugEnabled =
      typeof options.debug === "boolean"
        ? options.debug
        : process.env.META_MCP_DEBUG === "1" ||
          (process.env.DEBUG?.includes("meta-mcp") ?? false);
  }

  get authManager(): AuthManager {
    return this.auth;
  }

  private debug(...args: unknown[]): void {
    if (this.debugEnabled) {
      console.log(...args);
    }
  }

  private normalizeStatusFilter(
    status?: string | string[]
  ): string | undefined {
    if (!status) return undefined;
    return JSON.stringify(Array.isArray(status) ? status : [status]);
  }

  private appendQueryParams(
    url: string,
    params: Record<string, string>
  ): string {
    const separator = url.includes("?") ? "&" : "?";
    return `${url}${separator}${new URLSearchParams(params).toString()}`;
  }

  private async makeRequest<T>(
    endpoint: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: any,
    accountId?: string,
    isWriteCall: boolean = false
  ): Promise<T> {
    let url = `${this.auth.getBaseUrl()}/${this.auth.getApiVersion()}/${endpoint}`;
    const appSecretProof = this.auth.getAppSecretProof();
    if (appSecretProof) {
      url = this.appendQueryParams(url, { appsecret_proof: appSecretProof });
    }

    // Check rate limit if we have an account ID
    if (accountId) {
      await globalRateLimiter.checkRateLimit(accountId, isWriteCall);
    }

    return retryWithBackoff(async () => {
      const headers = this.auth.getAuthHeaders();

      const requestOptions: any = {
        method,
        headers,
      };

      if (body && method !== "GET") {
        if (typeof body === "string") {
          requestOptions.body = body;
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        } else {
          requestOptions.body = JSON.stringify(body);
          headers["Content-Type"] = "application/json";
        }
      }

      const controller =
        this.requestTimeoutMs > 0 ? new AbortController() : undefined;
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      if (controller) {
        requestOptions.signal = controller.signal;
        timeoutId = setTimeout(
          () => controller.abort(),
          this.requestTimeoutMs
        );
      }

      try {
        const response = await fetch(url, requestOptions);
        return MetaApiErrorHandler.handleResponse(response as any);
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          error.message = `Request timed out after ${this.requestTimeoutMs}ms: ${method} ${endpoint}`;
        }
        throw error;
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    }, `${method} ${endpoint}`);
  }

  private buildQueryString(params: Record<string, any>): string {
    const urlParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          urlParams.set(key, JSON.stringify(value));
        } else if (typeof value === "object") {
          urlParams.set(key, JSON.stringify(value));
        } else {
          urlParams.set(key, String(value));
        }
      }
    }

    return urlParams.toString();
  }

  // Account Methods
  async getAdAccounts(): Promise<AdAccount[]> {
    const allAccounts: AdAccount[] = [];
    let nextUrl: string | undefined = "me/adaccounts?fields=id,name,account_status,balance,currency,timezone_name,business&limit=100";
    
    // Fetch all pages of accounts
    while (nextUrl) {
      const response: MetaApiResponse<AdAccount> = await this.makeRequest<MetaApiResponse<AdAccount>>(
        nextUrl
      );
      
      allAccounts.push(...response.data);
      
      // Check if there's a next page
      if (response.paging?.next) {
        // Extract the relative path from the full URL
        const nextPageUrl = new URL(response.paging.next);
        nextUrl = nextPageUrl.pathname.substring(1) + nextPageUrl.search; // Remove leading '/'
      } else {
        nextUrl = undefined;
      }
    }
    
    return allAccounts;
  }

  // Campaign Methods
  async getCampaigns(
    accountId: string,
    params: PaginationParams & { status?: string | string[]; fields?: string[] } = {}
  ): Promise<PaginatedResult<Campaign>> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const { status, fields, ...paginationParams } = params;

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,objective,status,effective_status,created_time,updated_time,start_time,stop_time,budget_remaining,daily_budget,lifetime_budget",
      ...paginationParams,
    };

    const statusFilter = this.normalizeStatusFilter(status);
    if (statusFilter) {
      queryParams.effective_status = statusFilter;
    }

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<Campaign>>(
      `${formattedAccountId}/campaigns?${query}`,
      "GET",
      null,
      formattedAccountId
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  async getCampaign(campaignId: string): Promise<Campaign> {
    return this.makeRequest<Campaign>(
      `${campaignId}?fields=id,name,objective,status,effective_status,created_time,updated_time,start_time,stop_time,budget_remaining,daily_budget,lifetime_budget,account_id`
    );
  }

  async createCampaign(
    accountId: string,
    campaignData: {
      name: string;
      objective: string;
      status?: string;
      daily_budget?: number;
      lifetime_budget?: number;
      start_time?: string;
      stop_time?: string;
      special_ad_categories?: string[];
      bid_strategy?: string;
      bid_cap?: number;
      is_budget_optimization_enabled?: boolean;
    }
  ): Promise<{ id: string }> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const body = this.buildQueryString(campaignData);

    return this.makeRequest<{ id: string }>(
      `${formattedAccountId}/campaigns`,
      "POST",
      body,
      formattedAccountId,
      true
    );
  }

  async updateCampaign(
    campaignId: string,
    updates: {
      name?: string;
      status?: string;
      daily_budget?: number;
      lifetime_budget?: number;
      start_time?: string;
      stop_time?: string;
    }
  ): Promise<{ success: boolean }> {
    const body = this.buildQueryString(updates);

    return this.makeRequest<{ success: boolean }>(
      campaignId,
      "POST",
      body,
      undefined,
      true
    );
  }

  async deleteCampaign(campaignId: string): Promise<{ success: boolean }> {
    return this.makeRequest<{ success: boolean }>(
      campaignId,
      "DELETE",
      null,
      undefined,
      true
    );
  }

  // Ad Set Methods
  async getAdSets(
    params: PaginationParams & {
      campaignId?: string;
      accountId?: string;
      status?: string | string[];
      fields?: string[];
    } = {}
  ): Promise<PaginatedResult<AdSet>> {
    const { campaignId, accountId, status, fields, ...paginationParams } =
      params;

    let endpoint: string;
    if (campaignId) {
      endpoint = `${campaignId}/adsets`;
    } else if (accountId) {
      const formattedAccountId = this.auth.getAccountId(accountId);
      endpoint = `${formattedAccountId}/adsets`;
    } else {
      throw new Error("Either campaignId or accountId must be provided");
    }

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,campaign_id,status,effective_status,created_time,updated_time,start_time,end_time,daily_budget,lifetime_budget,bid_amount,billing_event,optimization_goal",
      ...paginationParams,
    };

    const statusFilter = this.normalizeStatusFilter(status);
    if (statusFilter) {
      queryParams.effective_status = statusFilter;
    }

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<AdSet>>(
      `${endpoint}?${query}`,
      "GET",
      null,
      accountId ? this.auth.getAccountId(accountId) : undefined
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  async createAdSet(
    campaignId: string,
    adSetData: {
      name: string;
      daily_budget?: number;
      lifetime_budget?: number;
      optimization_goal: string;
      billing_event: string;
      bid_amount?: number;
      start_time?: string;
      end_time?: string;
      targeting?: any;
      status?: string;
      promoted_object?: {
        page_id?: string;
        pixel_id?: string;
        application_id?: string;
        object_store_url?: string;
        custom_event_type?: string;
      };
      attribution_spec?: Array<{
        event_type: string;
        window_days: number;
      }>;
      destination_type?: string;
      is_dynamic_creative?: boolean;
      use_new_app_click?: boolean;
      configured_status?: string;
      optimization_sub_event?: string;
      recurring_budget_semantics?: boolean;
    }
  ): Promise<{ id: string }> {
    // First, get the campaign to find its account_id
    const campaign = await this.getCampaign(campaignId);
    const accountId = campaign.account_id;

    if (!accountId) {
      throw new Error("Unable to determine account ID from campaign");
    }

    const formattedAccountId = this.auth.getAccountId(accountId);

    // Ensure campaign_id is included in the request body
    const requestData = {
      ...adSetData,
      campaign_id: campaignId,
    };

    const body = this.buildQueryString(requestData);

    // Enhanced debugging for ad set creation
    this.debug("=== AD SET CREATION DEBUG ===");
    this.debug("Campaign ID:", campaignId);
    this.debug("Account ID:", accountId);
    this.debug("Formatted Account ID:", formattedAccountId);
    this.debug("Request Data Object:", JSON.stringify(requestData, null, 2));
    this.debug("Request Body (URL-encoded):", body);
    this.debug("API Endpoint:", `${formattedAccountId}/adsets`);
    this.debug("===========================");

    try {
      const result = await this.makeRequest<{ id: string }>(
        `${formattedAccountId}/adsets`,
        "POST",
        body,
        formattedAccountId,
        true
      );

      this.debug("=== AD SET CREATION SUCCESS ===");
      this.debug("Created Ad Set ID:", result.id);
      this.debug("==============================");

      return result;
    } catch (error) {
      this.debug("=== AD SET CREATION ERROR ===");
      this.debug("Error object:", error);

      if (error instanceof Error) {
        this.debug("Error message:", error.message);

        // Try to parse error response if it's JSON
        try {
          const errorData = JSON.parse(error.message);
          this.debug("Parsed error data:", JSON.stringify(errorData, null, 2));

          if (errorData.error) {
            this.debug("Meta API Error Details:");
            this.debug("- Message:", errorData.error.message);
            this.debug("- Code:", errorData.error.code);
            this.debug("- Type:", errorData.error.type);
            this.debug("- Error Subcode:", errorData.error.error_subcode);
            this.debug("- FBTrace ID:", errorData.error.fbtrace_id);

            if (errorData.error.error_data) {
              this.debug(
                "- Error Data:",
                JSON.stringify(errorData.error.error_data, null, 2)
              );
            }

            if (errorData.error.error_user_title) {
              this.debug("- User Title:", errorData.error.error_user_title);
            }

            if (errorData.error.error_user_msg) {
              this.debug("- User Message:", errorData.error.error_user_msg);
            }
          }
        } catch (parseError) {
          this.debug(
            "Could not parse error as JSON, raw message:",
            error.message
          );
        }
      }
      this.debug("============================");

      throw error;
    }
  }

  // Insights Methods
  async getInsights(
    objectId: string,
    params: {
      level?: "account" | "campaign" | "adset" | "ad";
      date_preset?: string;
      time_range?: { since: string; until: string };
      fields?: string[];
      breakdowns?: string[];
      limit?: number;
      after?: string;
    } = {}
  ): Promise<PaginatedResult<AdInsights>> {
    const queryParams: Record<string, any> = {
      fields:
        params.fields?.join(",") ||
        "impressions,clicks,spend,reach,frequency,ctr,cpc,cpm,actions,cost_per_action_type",
      ...params,
    };

    if (params.time_range) {
      queryParams.time_range = params.time_range;
    }

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<AdInsights>>(
      `${objectId}/insights?${query}`
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  // Custom Audience Methods
  async getCustomAudiences(
    accountId: string,
    params: PaginationParams & { fields?: string[] } = {}
  ): Promise<PaginatedResult<CustomAudience>> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const { fields, ...paginationParams } = params;

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,description,subtype,approximate_count,data_source,retention_days,creation_time,operation_status",
      ...paginationParams,
    };

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<CustomAudience>>(
      `${formattedAccountId}/customaudiences?${query}`,
      "GET",
      null,
      formattedAccountId
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  async createCustomAudience(
    accountId: string,
    audienceData: {
      name: string;
      description?: string;
      subtype: string;
      customer_file_source?: string;
      retention_days?: number;
      rule?: any;
    }
  ): Promise<{ id: string }> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const body = this.buildQueryString(audienceData);

    return this.makeRequest<{ id: string }>(
      `${formattedAccountId}/customaudiences`,
      "POST",
      body,
      formattedAccountId,
      true
    );
  }

  async createLookalikeAudience(
    accountId: string,
    audienceData: {
      name: string;
      origin_audience_id: string;
      country: string;
      ratio: number;
      description?: string;
    }
  ): Promise<{ id: string }> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const body = this.buildQueryString({
      ...audienceData,
      subtype: "LOOKALIKE",
      lookalike_spec: {
        ratio: audienceData.ratio,
        country: audienceData.country,
        type: "similarity",
      },
    });

    return this.makeRequest<{ id: string }>(
      `${formattedAccountId}/customaudiences`,
      "POST",
      body,
      formattedAccountId,
      true
    );
  }

  // Creative Methods
  async getAdCreatives(
    accountId: string,
    params: PaginationParams & { fields?: string[] } = {}
  ): Promise<PaginatedResult<AdCreative>> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const { fields, ...paginationParams } = params;

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,title,body,image_url,video_id,call_to_action,object_story_spec",
      ...paginationParams,
    };

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<AdCreative>>(
      `${formattedAccountId}/adcreatives?${query}`,
      "GET",
      null,
      formattedAccountId
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  async createAdCreative(
    accountId: string,
    creativeData: {
      name: string;
      object_story_spec: any;
      degrees_of_freedom_spec?: any;
    }
  ): Promise<AdCreative> {
    const formattedAccountId = this.auth.getAccountId(accountId);

    // Send as JSON object (not form-encoded) to preserve special characters
    // in nested objects like object_story_spec
    return this.makeRequest<AdCreative>(
      `${formattedAccountId}/adcreatives`,
      "POST",
      creativeData,
      formattedAccountId,
      true
    );
  }

  // Ad Management
  async createAd(
    accountId: string,
    adData: {
      name: string;
      adset_id: string;
      creative: { creative_id: string };
      status?: string;
    }
  ): Promise<Ad> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    this.debug("=== CREATE AD DEBUG ===");
    this.debug("Account ID:", formattedAccountId);
    this.debug("Ad Data:", JSON.stringify(adData, null, 2));

    const body = this.buildQueryString(adData);
    this.debug("Request body:", body);
    this.debug("API endpoint:", `${formattedAccountId}/ads`);

    try {
      const result = await this.makeRequest<Ad>(
        `${formattedAccountId}/ads`,
        "POST",
        body,
        formattedAccountId,
        true
      );

      this.debug("Create ad success:", JSON.stringify(result, null, 2));
      this.debug("=====================");
      return result;
    } catch (error) {
      this.debug("=== CREATE AD ERROR ===");
      this.debug("Error object:", error);

      if (error instanceof Error) {
        this.debug("Error message:", error.message);

        // Try to parse Meta API error response
        try {
          const errorData = JSON.parse(error.message);
          this.debug(
            "Parsed Meta API error:",
            JSON.stringify(errorData, null, 2)
          );

          if (errorData.error) {
            this.debug("Meta API Error Details:");
            this.debug("- Message:", errorData.error.message);
            this.debug("- Code:", errorData.error.code);
            this.debug("- Type:", errorData.error.type);
            this.debug("- Error Subcode:", errorData.error.error_subcode);
            this.debug("- FBTrace ID:", errorData.error.fbtrace_id);
          }
        } catch (parseError) {
          this.debug(
            "Could not parse error as JSON, raw message:",
            error.message
          );
        }
      }
      this.debug("=====================");
      throw error;
    }
  }

  async updateAd(
    adId: string,
    updates: {
      name?: string;
      status?: string;
      creative?: { creative_id: string };
    }
  ): Promise<{ success: boolean }> {
    const body = this.buildQueryString(updates);
    return this.makeRequest<{ success: boolean }>(
      adId,
      "POST",
      body,
      undefined,
      true
    );
  }

  async getAd(
    adId: string,
    fields?: string[]
  ): Promise<Ad> {
    const queryParams = {
      fields: fields?.join(",") ||
        "id,name,adset_id,campaign_id,status,effective_status,created_time,updated_time,creative",
    };
    const query = this.buildQueryString(queryParams);
    return this.makeRequest<Ad>(`${adId}?${query}`);
  }

  async duplicateAd(
    adId: string,
    adSetId?: string
  ): Promise<{ copied_ad_id: string }> {
    const body: Record<string, any> = {
      status_option: "PAUSED",
      rename_strategy: "NO_RENAME",
    };
    if (adSetId) {
      body.adset_id = adSetId;
    }
    const bodyStr = this.buildQueryString(body);
    return this.makeRequest<{ copied_ad_id: string }>(
      `${adId}/copies`,
      "POST",
      bodyStr || undefined,
      undefined,
      true
    );
  }

  // Ad Methods
  async getAds(
    params: PaginationParams & {
      adsetId?: string;
      campaignId?: string;
      accountId?: string;
      status?: string | string[];
      fields?: string[];
    } = {}
  ): Promise<PaginatedResult<Ad>> {
    const {
      adsetId,
      campaignId,
      accountId,
      status,
      fields,
      ...paginationParams
    } = params;

    let endpoint: string;
    if (adsetId) {
      endpoint = `${adsetId}/ads`;
    } else if (campaignId) {
      endpoint = `${campaignId}/ads`;
    } else if (accountId) {
      const formattedAccountId = this.auth.getAccountId(accountId);
      endpoint = `${formattedAccountId}/ads`;
    } else {
      throw new Error(
        "Either adsetId, campaignId, or accountId must be provided"
      );
    }

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,adset_id,campaign_id,status,effective_status,created_time,updated_time,creative",
      ...paginationParams,
    };

    const statusFilter = this.normalizeStatusFilter(status);
    if (statusFilter) {
      queryParams.effective_status = statusFilter;
    }

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<Ad>>(
      `${endpoint}?${query}`,
      "GET",
      null,
      accountId ? this.auth.getAccountId(accountId) : undefined
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  async getAdsByCampaign(
    campaignId: string,
    params: PaginationParams & { status?: string[] } = {}
  ): Promise<PaginatedResult<Ad>> {
    const queryParams: Record<string, any> = {
      fields: "id,name,status,effective_status,created_time,adset_id,creative",
      limit: params.limit || 25,
      after: params.after,
      before: params.before,
    };

    if (params.status) {
      queryParams.status = JSON.stringify(params.status);
    }

    const query = this.buildQueryString(queryParams);
    const result = await this.makeRequest<MetaApiResponse<Ad>>(
      `${campaignId}/ads?${query}`,
      "GET",
      undefined,
      undefined
    );

    return PaginationHelper.parsePaginatedResponse(result);
  }

  async getAdsByAccount(
    accountId: string,
    params: PaginationParams & { status?: string[] } = {}
  ): Promise<PaginatedResult<Ad>> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const queryParams: Record<string, any> = {
      fields: "id,name,status,effective_status,created_time,adset_id,creative",
      limit: params.limit || 25,
      after: params.after,
      before: params.before,
    };

    if (params.status) {
      queryParams.status = JSON.stringify(params.status);
    }

    const query = this.buildQueryString(queryParams);
    const result = await this.makeRequest<MetaApiResponse<Ad>>(
      `${formattedAccountId}/ads?${query}`,
      "GET",
      undefined,
      formattedAccountId
    );

    return PaginationHelper.parsePaginatedResponse(result);
  }

  // Account and Business Methods
  async getAdAccount(accountId: string): Promise<AdAccount> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const queryParams = {
      fields:
        "id,name,account_status,currency,timezone_name,funding_source_details,business",
    };

    const query = this.buildQueryString(queryParams);
    return this.makeRequest<AdAccount>(
      `${formattedAccountId}?${query}`,
      "GET",
      undefined,
      formattedAccountId
    );
  }

  async getFundingSources(accountId: string): Promise<any[]> {
    const formattedAccountId = this.auth.getAccountId(accountId);

    try {
      const result = await this.makeRequest<MetaApiResponse<any>>(
        `${formattedAccountId}/funding_source_details`,
        "GET",
        undefined,
        formattedAccountId
      );
      return result.data || [];
    } catch (error) {
      // Return empty array if no permission to access funding sources
      return [];
    }
  }

  async getAccountBusiness(accountId: string): Promise<any> {
    const formattedAccountId = this.auth.getAccountId(accountId);

    try {
      return await this.makeRequest<any>(
        `${formattedAccountId}/business`,
        "GET",
        undefined,
        formattedAccountId
      );
    } catch (error) {
      // Return empty object if no business info available
      return {};
    }
  }

  async getCustomAudience(audienceId: string): Promise<CustomAudience> {
    const queryParams = {
      fields:
        "id,name,description,approximate_count,delivery_status,operation_status",
    };

    const query = this.buildQueryString(queryParams);
    return this.makeRequest<CustomAudience>(`${audienceId}?${query}`, "GET");
  }

  // Batch Operations
  async batchRequest(requests: BatchRequest[]): Promise<BatchResponse[]> {
    const body = this.buildQueryString({
      batch: JSON.stringify(requests),
    });

    return this.makeRequest<BatchResponse[]>("", "POST", body, undefined, true);
  }

  // Utility Methods
  async estimateAudienceSize(
    accountId: string,
    targeting: any,
    optimizationGoal: string
  ): Promise<{ estimate_mau: number; estimate_dau?: number }> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const queryParams = {
      targeting_spec: targeting,
      optimization_goal: optimizationGoal,
    };

    const query = this.buildQueryString(queryParams);
    return this.makeRequest<{ estimate_mau: number; estimate_dau?: number }>(
      `${formattedAccountId}/delivery_estimate?${query}`,
      "GET",
      null,
      formattedAccountId
    );
  }

  async generateAdPreview(
    creativeId: string,
    adFormat: string,
    productItemIds?: string[]
  ): Promise<{ body: string }> {
    const queryParams: Record<string, any> = {
      ad_format: adFormat,
    };

    if (productItemIds && productItemIds.length > 0) {
      queryParams.product_item_ids = productItemIds;
    }

    const query = this.buildQueryString(queryParams);
    return this.makeRequest<{ body: string }>(
      `${creativeId}/previews?${query}`
    );
  }

  // Helper method to get account ID for rate limiting
  extractAccountIdFromObjectId(objectId: string): string | undefined {
    // Try to extract account ID from campaign/adset/ad ID patterns
    const campaign = objectId.match(/^(\d+)$/);
    if (campaign) {
      // For direct campaign/adset/ad IDs, we can't determine the account
      // This would need to be provided by the caller or cached
      return undefined;
    }

    // If it's already a formatted account ID
    if (objectId.startsWith("act_")) {
      return objectId;
    }

    return undefined;
  }

  // Image Upload for v23.0 compliance
  async uploadImageFromUrl(
    accountId: string,
    imageUrl: string,
    imageName?: string
  ): Promise<{ hash: string; url: string; name: string }> {
    try {
      const formattedAccountId = this.auth.getAccountId(accountId);

      this.debug("=== IMAGE UPLOAD FROM URL DEBUG ===");
      this.debug("Account ID:", formattedAccountId);
      this.debug("Image URL:", imageUrl);
      this.debug("Image Name:", imageName);

      // Download the image from the URL
      this.debug("Downloading image from URL...");
      const imageResponse = await fetch(imageUrl);

      if (!imageResponse.ok) {
        throw new Error(
          `Failed to download image: ${imageResponse.status} ${imageResponse.statusText}`
        );
      }

      const imageBuffer = await imageResponse.arrayBuffer();
      const imageBlob = new Blob([imageBuffer], {
        type: imageResponse.headers.get("content-type") || "image/jpeg",
      });

      this.debug("Image downloaded, size:", imageBuffer.byteLength, "bytes");
      this.debug("Content type:", imageResponse.headers.get("content-type"));

      // Generate filename if not provided
      const filename = imageName || `uploaded_image_${Date.now()}.jpg`;

      // Create FormData for upload
      const formData = new FormData();
      formData.append("filename", imageBlob, filename);
      formData.append("access_token", this.auth.getAccessToken());

      this.debug("Uploading to Meta API...");
      this.debug(
        "Endpoint:",
        `https://graph.facebook.com/v22.0/${formattedAccountId}/adimages`
      );

      // Upload to Meta API
      const uploadResponse = await fetch(
        `https://graph.facebook.com/v23.0/${formattedAccountId}/adimages`,
        {
          method: "POST",
          body: formData,
        }
      );

      const uploadResult = (await uploadResponse.json()) as any;
      this.debug("Upload response:", JSON.stringify(uploadResult, null, 2));

      if (!uploadResponse.ok) {
        this.debug("Upload failed with status:", uploadResponse.status);
        throw new Error(`Image upload failed: ${JSON.stringify(uploadResult)}`);
      }

      // Extract image hash from response
      const images = uploadResult.images;
      if (!images || Object.keys(images).length === 0) {
        throw new Error("No image hash returned from Meta API");
      }

      // Get the first (and usually only) image result
      const imageKey = Object.keys(images)[0];
      const imageResult = images[imageKey];

      if (!imageResult.hash) {
        throw new Error("No hash found in image upload response");
      }

      this.debug("Image uploaded successfully!");
      this.debug("Image hash:", imageResult.hash);
      this.debug("Image URL:", imageResult.url);
      this.debug("===================================");

      return {
        hash: imageResult.hash,
        url: imageResult.url || imageUrl,
        name: filename,
      };
    } catch (error) {
      this.debug("=== IMAGE UPLOAD ERROR ===");
      this.debug("Error:", error);
      this.debug("=========================");
      throw error;
    }
  }
}
