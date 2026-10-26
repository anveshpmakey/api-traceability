package com.acme.payments;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class PaymentProcessor {
    private final RestTemplate restTemplate = new RestTemplate();

    @Value("${stripe.api-url}")
    private String stripeUrl;

    public String charge(Object request) {
        return restTemplate.postForObject(stripeUrl + "/charges", request, String.class);
    }
}
