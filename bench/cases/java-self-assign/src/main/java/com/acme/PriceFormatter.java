package com.acme;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.Map;

public class PriceFormatter {
    private final String currency;
    private Map<String, BigDecimal> rates;

    public PriceFormatter(String currency, Map<String, BigDecimal> rates) {
        this.currency = currency;
        rates = rates;
    }

    public String format(BigDecimal usd) {
        // Rates are refreshed by the nightly job and can be missing for a
        // currency we have not priced yet.
        BigDecimal rate = rates.get(currency);
        return usd.multiply(rate).setScale(2, RoundingMode.HALF_UP) + " " + currency;
    }
}
