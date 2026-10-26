package com.acme.customers;

import org.springframework.data.mongodb.repository.MongoRepository;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/customers")
public class CustomerController {
    private final CustomerRepository customers;

    public CustomerController(CustomerRepository customers) {
        this.customers = customers;
    }

    @GetMapping("/{id}/verification")
    public boolean verify(@PathVariable String id) {
        return customers.existsById(id);
    }
}

interface CustomerRepository extends MongoRepository<Customer, String> {}
