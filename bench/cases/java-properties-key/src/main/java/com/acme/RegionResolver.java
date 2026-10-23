package com.acme;

public class RegionResolver {
    private final Settings settings;

    public RegionResolver(Settings settings) {
        this.settings = settings;
    }

    public String endpoint() {
        // The region comes from the deploy environment; on a developer
        // machine it is unset and we should fall back to us-east-1.
        String region = settings.get("region.default").trim();
        return "https://billing." + region + ".example.com";
    }
}
