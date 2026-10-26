package com.acme.payments;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping(path = {"/api/payments"})
public class PaymentController {

    private final PaymentProcessor processor;
    private final PaymentLedger ledger;

    public PaymentController(PaymentProcessor processor, PaymentLedger ledger) {
        this.processor = processor;
        this.ledger = ledger;
    }

    @PostMapping
    public String charge(@RequestBody Object request) {
        String id = processor.charge(request);
        ledger.record(id);
        return id;
    }

    @GetMapping("/{paymentId}")
    public Object status(@PathVariable String paymentId) {
        return ledger.find(paymentId);
    }
}
