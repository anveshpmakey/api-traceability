package com.acme.orders.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpMethod;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

@Component
public class PaymentClient {

    private final RestTemplate restTemplate;

    @Value("${clients.payment.url}")
    private String paymentUrl;

    public PaymentClient(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public void charge(String customerId, long amountCents) {
        restTemplate.postForEntity(paymentUrl + "/api/payments", new Object(), Void.class);
    }

    public Object status(String paymentId) {
        return restTemplate.exchange(paymentUrl + "/api/payments/" + paymentId, HttpMethod.GET, null, Object.class);
    }
}
